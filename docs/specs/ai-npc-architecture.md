# AI NPC 架构规格（onchainpal）

> 状态：草案 v0.1（2026-05）。本文档归档 AI NPC 系统的架构重设计与 AIGG/GCC 集成方向。
> 对应代码已落地：P0 步骤 ①②（`@aigg/npc-agent` 契约包 + `PalAgentAdapter` 接缝）。
> 相关项目记忆：`product-direction` / `ai-npc-gap` / `ai-npc-architecture` / `aigg-gcc-integration`。

---

## 1. 产品定位

**「一个用 AI NPC 重制的、世界状态上链的怀旧风 RPG」**，把唯一差异化押在 **AI NPC**，其余（voxel 3D / mobile / 发币）后置。

- **PAL（仙剑 / h5pal 移植）只是临时 demo 外壳**，非最终 IP；商业化前需原创化美术/剧情以规避版权。
- **onchain 主线（2026-05 校准）= NPC 推理付费走 AIGG 的 GCC + nanopayment**（每次 NPC 推理 = 可计量、可证明的 GCC 消耗）。**游戏/世界/关系状态上链不是必须**，降级为可选/后置；本地持久化（IndexedDB）足够。详见 §6 与 `docs/specs/npc-economy-and-gcc.md`（NPC 经济与钱包模型）。

评估任何新功能先问：**它是否服务于 AI NPC 这个楔子？** 不是就后置。

---

## 2. 现状审计与结构性问题

旧 AI 层是一个 **500ms 轮询 tick**（`AIController._tick`）驱动的系统，混了两件事：

1. **自动游玩 bot（主体）**：LLM 被 prompt「操控主角一行」，输出 move/interact/battle —— 是 demo/测试自动驾驶，与产品无关，却占大部分代码。
2. **NPC 台词生成器**：`npc-behaviours` 每个 NPC 被轮询 `plan()`，玩家靠近时跟 LLM 要**一行台词**，Big5 编码塞进对话缓冲。

### 结构性问题（地基朝向错，非 bug）

| # | 问题 |
|---|---|
| P1 | 主抽象错位：中心是全局「每 tick 决策一次」，NPC 不是一等 agent（无自己的记忆/关系/目标/决策循环） |
| P2 | 自动游玩 与 NPC 大脑 混在一个循环 |
| P3 | LLM 输出是文本/动作枚举，**不能改世界状态**（无法推进剧情）—— 头号阻断 |
| P4 | 记忆临时、全局、形状错：3–10 行内存、刷新即失、存的是对话流不是关系；`reputation: undefined // TODO` |
| P5 | 与 PAL 引擎焊死：Big5 / `PAL_X/PAL_Y` / `DialogPosition` / eventId 全在「大脑」层 |
| P6 | 无状态/持久化/上链分层，上链支柱无接缝可挂 |
| P7 | 非确定性 LLM 不可上链未处理 |
| P8 | 写死本地 Ollama，且 LLM 调用在 tick 热路径上 |

---

## 3. 目标架构

把「引擎无关」做成**包边界**（像 voxel-lab 那样用单向依赖强制：大脑 import 不到 PAL）。

```
┌──────────────────────────────────────────────────────────────┐
│  PAL Adapter  ← 唯一 PAL-aware 层（game-engine/src/ai/）         │
│   感知: PAL 状态 → 中性 Perception DTO                          │
│   执行: Effect/台词 → Big5 + 对话缓冲 / flag / 物品              │
│   (将来换原创 IP = 换这一层，大脑不动)                          │
└──────────▲───────────────────────────────┬────────────────────┘
        perceptions                      effects / 台词
┌──────────┴───────────────────────────────▼────────────────────┐
│  NPC Agent Runtime  ← @aigg/npc-agent，零 PAL 依赖         │
│   每 NPC: Persona / Memory / Goals / 决策策略                    │
│   事件驱动（玩家靠近/说话/flag 变），非 500ms 轮询               │
│   能力域：被允许 emit 哪些 Effect                                │
└──────────▲───────────────────────────────┬────────────────────┘
       prompt+上下文                   结构化 AgentIntent
┌──────────┴─────────┐      ┌──────────────▼────────────────────┐
│ InferenceProvider   │      │  EffectResolver（规则引擎）        │
│  Hosted=AiggProvider│      │  按 GameRules 校验 intent → 生成    │
│  (dev 先指 Ollama)  │      │  确定性 StateDelta                  │
│  只计量，返回 usage  │      └──────────────┬────────────────────┘
└─────────────────────┘                durable deltas
┌─────────────────────────────────────────────▼──────────────────┐
│  State / Persistence（分层，后端可换）                          │
│   Ephemeral(RAM) / Durable local(IndexedDB) / Onchain(MUD+GCC)  │
│   单一 Store 接口；`onchain` 标记的字段集 = contracts/world schema│
└─────────────────────────────────────────────────────────────────┘

依赖方向：game-engine ──→ npc-agent（编译期强制，反向不可能）
```

### 核心设计决定

1. **NPC agent 是基本单元**，全局循环退化成「把 Perception 路由给对应 agent」的调度器。
2. **事件驱动**，不再 tick 轮询 LLM（修 P8 延迟/成本）。
3. **结构化意图契约**：LLM 输出 `AgentIntent`（say + effects + memoryWrites），effects 必须过 `EffectResolver` 校验 —— 唯一改世界的路径（解 P3）。
4. **记忆 per (NPC × 玩家)**：working / episodic / semantic / **relationship**；检索按 (npcId, playerId, query)；后台 consolidation（解 P4）。现有 `knowledge-retriever` 是静态 lore RAG，≠ 记忆，可复用。
5. **持久化分层 = 上链接缝**：`Store` 单接口；`{ onchain: true }` 子集走链后端，其余本地。该子集的并集**字面上就是 contracts/world 表结构**（解 P6）。
6. **链下推理 / 链上结算分离**：LLM 永不上链；写链的永远是校验后的确定性 delta（解 P7）。
7. **大脑引擎无关**：adapter 之上不出现 Big5/PAL_X/DialogPosition（解 P5）。
8. **自动游玩 bot 抽离**为独立 `dev-autopilot`（dev flag 后），与 agent runtime 解耦（解 P2）。

---

## 4. 核心契约（已实现，见 `packages/npc-agent/src`）

```ts
// intent/ —— LLM 输出 = 决策，非文本
interface AgentIntent { say?: string; effects?: Effect[]; memoryWrites?: MemoryEntry[]; emotion?: string }
type Effect =
  | { kind: 'adjustRelationship'; delta: number; reason: string }
  | { kind: 'setFlag'; flag: string; value: number }
  | { kind: 'giveItem' | 'takeItem'; itemId: number; qty: number }
  | { kind: 'startQuest'; questId: string }
  | { kind: 'advanceQuest'; questId: string; step: string };
// EffectResolver 的输出，可上链的确定性增量
interface StateDelta { npcId; playerId; effects: Effect[]; memoryWrites; rejected: {effect; reason}[] }

// store/ —— 上链接缝在这，不在合约里
type Scope = {type:'npc-player';npcId;playerId} | {type:'player';playerId} | {type:'world'}
interface Store {
  get<T>(scope, key): Promise<T|null>;
  set<T>(scope, key, value, opts?: { onchain?: boolean }): Promise<void>;  // onchain 标记 = 未来 MUD 表
  delete(scope, key): Promise<void>;
}

// ports/ —— 宿主（PAL adapter）实现；agent 只认接口
interface PerceptionSource { subscribe(h:(p:Perception)=>void): Unsubscribe }
interface Actuator { say(npcId,line,opts?): Promise<void>; apply(delta: StateDelta): Promise<void> }
interface GameRules { validate(effect: Effect, ctx): RuleVerdict }

// inference/ —— 只计量，不背支付（见 §6）
interface InferenceProvider { id; complete(req): Promise<{ text; attestation? }> }

// agent/ —— 引擎无关大脑（事件驱动；impl = step③）
interface Agent { npcId; perceive(p: Perception): Promise<AgentIntent | null> }
```

---

## 5. 已确定的决策（用户拍板，2026-05）

| 决策点 | 选择 |
|---|---|
| 推理部署 | **托管 API**（`InferenceProvider` 抽象 → `AiggProvider`；dev 先指本地 Ollama） |
| 自动游玩 bot | **抽成独立 dev 工具**（`dev-autopilot`），与 agent runtime 解耦 |
| 上链节奏 | **先切接缝、本地优先**：`Store` 接口 + `onchain` 标记，v1 落 IndexedDB，后端日后换 MUD |
| 引擎无关 | 做成**包边界**：`@aigg/npc-agent` 零 PAL 依赖 |

---

## 6. AIGG / GCC 集成（onchain 主线）

> NPC 经济、钱包安全模型、GCC 来源、Base gas 结论的完整规格见 **`docs/specs/npc-economy-and-gcc.md`**。本节为摘要。

**愿景**：onchainpal 作为 **AIGG（= AI.GG = p2papi）的 GCC 消耗 demo** —— 每个 NPC 是带钱包的自治 agent，用**自己钱包里的 GCC 自费推理**。「玩游戏 = 通过 nano 消耗 GCC 算力额度」。这是 demo **唯一主要的 onchain 方向**；游戏状态上链非必须。

- **AIGG**：TEE 保护的 AI API 网关（sub2api fork，跑在 `ai.gg`），OpenAI 兼容，token 级计费。
- **GCC**（Guaranteed Capacity Credit）：**Base 主网 ERC-20**，Uniswap CCA 拍卖发行，带 **EIP-3009 transferWithAuthorization**（为 x402 结算而设计）。
- 计费：`tokens × 每模型乘数 → gcc_cost`（直接 GCC 计费，无 USD 桥）。

### 计量 vs 结算分离（关键）

```
每次 NPC 推理
  │
① 计量 Metering：tokens × 乘数 → gcc_cost      ← 永远 per-call、链下、便宜（会计事实）
  │
② 结算 Settlement：策略可插拔，不一定 per-call、不一定每次上链
   └─ X402Nanopayment { asset: GCC }
        每次签 EIP-3009 授权 → aigg-facilitator 批量结算上链（Circle Nanopayments 模式：gas-free、批量）
```

**成本现实（为何不能 per-call 上链）**：单次 NPC 回复 ≈ **$0.0003**（DeepSeek V4-Pro 永久降价 75% 后 = 输入 $0.435 / 输出 $0.87 每百万 token），而 Base L2 一笔 gas ≈ $0.0005–0.005 → **gas 比推理还贵**。结论：**链下逐次计量 + 批量结算**是唯一理性模型。

**nanopayment 资产 = GCC**：GCC 本就是 EIP-3009 ERC-20，天生插得进 x402 nanopayment rail。计量算出多少 GCC、nanopayment 就微支付多少 GCC —— **一个单位贯穿计量/消耗/结算/代币效用（「NPC 认知的燃料」）**。
- `SettlementStrategy` 简化为单一 `X402Nanopayment { asset: GCC }`，跑在 AIGG 自己的 `aigg-facilitator`。
- **Circle Nanopayments**（USDC、x402 v2、批量、gas-free、为 AI agent 用量计费）降级为**参考架构 / 可选 USDC 互操作路径**。

**分层模型路由**：推理极廉 → 寒暄/ambient 用廉价模型（DeepSeek V4-Pro），关键剧情才上强模型，对应 AIGG `gcc_pricing.json` 每模型乘数。几百次互动一局仅几美分。

**对架构的影响**：
- `AiggProvider.complete()` **只计量**：返回 `{ text, usage:{ tokens, gccCost } }`，不背支付。
- 新增独立 `SettlementStrategy` 接缝；换支付模式 = 换 strategy，不动 provider/agent。
- 充值/CCA/x402/合约全在 AIGG 侧，游戏只管消耗。

**待定（到集成时再定）**：默认 settlement 预付 vs nanopayment？鉴权平台 API key vs OKX agent 钱包？demo 用 Base 主网 GCC vs Sepolia？游戏内是否可视化 GCC 余额/单次消耗？

---

## 7. 迁移路径 / P0 竖切

1. ✅ 建 `packages/npc-agent` 骨架 + 三契约（intent/store/ports）。
2. ✅ `PalAgentAdapter` 把现有 `_renderDialog`/状态读取包进 ports —— 行为不变。
3. ⬜ **酒剑仙**搬上 Agent runtime：`AiggProvider`（dev 先指 Ollama）输出结构化 intent + 真 Effect（`adjustRelationship`/`setFlag`）+ `EffectResolver`。
4. ⬜ relationship 记忆，`IndexedDbStore` 持久化。
5. ⬜ 抽离 autopilot 到 `dev-autopilot`。
6. ⬜（可选/后置）`Store` 共享持久后端换 MUD，据 `onchain` 字段集生成 contracts/world 表 —— **游戏状态上链非必须**，移出关键路径。
7. ⬜（onchain 主线）`AgentWallet` 接缝 + `SettlementStrategy = X402Nanopayment{asset:GCC}`，NPC 用自己钱包的 GCC 自费推理 —— 详见 `docs/specs/npc-economy-and-gcc.md`。

**P0 验收**：和酒剑仙喝一次酒 → 他记住 → 重开游戏称呼从「客官」变「老friend」→ 一个世界 flag 点亮并持久化。

---

## 8. 当前状态（2026-05）

- **步骤 ①②✅ 完成**：`@aigg/npc-agent`（纯契约，零依赖、零行为）+ `game-engine/src/ai/pal-agent-adapter.ts`（唯一 PAL-aware 接缝）+ Big5 抽离到 `js/pal/big5.ts`。
- 验证：playground vite 构建通过（回归）；npc-agent 隔离类型检查零错；改动文件类型检查零错；全量类型错误 28→27。
- **接缝为纯接缝**：无 live 代码构造 `PalAgentAdapter` → 引擎运行时行为未变。驱动它的 agent runtime = 步骤 ③。
