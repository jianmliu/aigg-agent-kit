# NPC 经济与 GCC 钱包模型规格（onchainpal × AIGG）

> 状态：草案 v0.1（2026-05）。归档 onchainpal 作为 **AIGG GCC 合作项目**的经济模型：NPC 作为带钱包的自治 agent、用自己的 GCC 自费推理。
> 配套：`docs/specs/ai-npc-architecture.md`（§6 引用本文）。项目记忆：`aigg-gcc-integration`。

---

## 1. 核心理念

NPC 不再是被供养的纸片人，而是**有自己钱包、需要自负算力开销的自治经济体**：

> **NPC 拥有钱包 → 思考时消耗自己钱包里的 GCC → 没有 GCC 就思考不动。**

这同时是两样东西：
- **GCC 消耗的最强 demo**：每个 NPC 的"念头"都是一笔可计量、可证明的 GCC 消耗。
- **一条真游戏机制**（"认知代谢"，见 §4）：余额决定 NPC 有多聪明、多活跃。

**合作叙事**：AIGG 的战略（`aigg-src/docs/STRATEGY.md`）在寻找 "first paid agent" —— 无银行账户、用加密钱包自费推理的自治 agent。**onchainpal 的 NPC 群正是这一人群的规模化来源。**

---

## 2. onchain 优先级（2026-05 校准）

- **唯一主要 onchain 方向 = NPC 推理付费走 AIGG 的 GCC + nanopayment。**
- **游戏 / 世界 / 关系状态上链（MUD / contracts/world）不是必须**，降级为可选 / 后置；本地持久化（IndexedDB）足够支撑"有记忆的 NPC"。
- onchain 故事完全落在**推理付费层**，不在游戏状态层。

---

## 3. Agentic Wallet 安全模型（"安全地让 NPC 访问钱包"）

**已确认事实（AIGG 仓库）**：OKX Agentic Wallet 提供绑定钱包身份（每账户 `wallets.json` → Base 地址 `chainIndex 8453`），持有 ETH/USDC/**GCC** 余额（与平台余额分离），走 x402 结算；AIGG 已用 Phala dstack TEE 封存凭证。

每个 NPC 的安全模型：

| 层 | 机制 | 状态 |
|---|---|---|
| **身份** | 每个 NPC 一个 agentic wallet 地址 → 真 Base 地址持 GCC | OKX 已有 |
| **委托签名** | agent 运行时用 **session key** 自主签 x402 / EIP-3009 GCC 支付授权；游戏客户端**永不持有主私钥**，无需逐次人工批准 | agentic wallet 核心能力 |
| **策略护栏** | 给签名授权限定作用域：**单次推理上限 + 每日/总额上限 + 收款方白名单（只能付 AIGG facilitator / 结算合约）+ 过期可撤销** | 建议配置 |
| **托管** | 密钥由 agentic wallet 基础设施持有，可进一步**封进 Phala TEE** → 运营方 / 客户端都无法 exfiltrate | 建议（TEE 已在用） |
| **可审计** | 每笔消耗 = 一份 x402 授权 → 链上 / attested 轨迹："NPC X 花 N GCC 想了 Y" | x402 天然 |

> **核心保证**：NPC 能"自己花钱思考"，但被策略 + TEE 锁死下限。被攻破的最坏后果只是烧光它**自己那点封顶的 GCC**——既不能盗走，也不能付给白名单外的任何地址。

---

## 4. GCC 来源与认知代谢

GCC 三来源（均成立，各对应一个机制）：

1. **AIGG 捐赠** —— NPC spawn 时 faucet 打种子 GCC（demo 启动最省事）。
2. **任何人捐赠** —— NPC 地址是公开 Base 地址，谁都能转 GCC 进去 → **赞助 / 供养机制**（"给喜欢的 NPC 充值，让它更聪明、更爱说话"）。
3. **Agent 自己赚** —— NPC 完成任务 / 卖信息 / 玩家打赏；甚至 **NPC 自己就是一个 x402 endpoint**，别的 agent 付费咨询它 → 赚 GCC。

**认知代谢机制**：
- 余额充足 → 用强模型、思考频繁。
- 余额见底 → 自动降到廉价模型（DeepSeek V4-Pro）或回退脚本台词（"精神不济"），直到被充值 / 赚到。
- 实现：NPC 钱包余额直接喂给 `AiggProvider` 的**分层模型路由**。

---

## 5. 计量 vs 结算（回顾，详见架构 spec §6）

```
每次 NPC 推理
  │
① 计量 Metering：tokens × 每模型乘数 → gcc_cost   ← 永远 per-call、链下、便宜（会计事实）
  │
② 结算 Settlement：X402Nanopayment { asset: GCC }
     NPC 用 session key 签 EIP-3009 授权 → aigg-facilitator 批量结算上链（Circle Nanopayments 模式：批量、gas-free）
     付款来源 = 该 NPC 的 AgentWallet（非全局玩家余额）
```

GCC 是**唯一单位**：计量算出多少 GCC、nanopayment 就微支付多少 GCC（无 USD 桥）。

---

## 6. Base 手续费结论

基准对照（NPC 单次推理 ≈ **$0.0003**，DeepSeek V4-Pro 永久降价 75% 后）。Base 当前 base fee ≈ **0.005 Gwei**，单笔 transfer ≈ **$0.001–0.01**（L2 普遍 sub-$0.03）。

| 用法 | Base 单笔 gas | 相对推理成本 | 够低？ |
|---|---|---|---|
| naive 每次思考单独上链 | ~$0.001–0.01 | **3×–30×** 推理本身 | ❌ 不够（gas 比要结算的 GCC 还贵） |
| **批量 nanopayment**（数千笔 → 1 次链上承诺） | 同一笔 gas ÷ 数千 | **每笔 ~$10⁻⁷ 级** | ✅ 可忽略 |

**结论**：Base 对**批量结算**足够低（摊薄后每笔趋近于零）——正是我们选的模型；但对 naive 逐笔上链仍不够低。

**更关键：NPC 端 gasless。** 在 x402 + EIP-3009 + facilitator 下，NPC 只离线签授权，由 **aigg-facilitator 代为上链并垫付 gas**。所以：
- **NPC 钱包只需持 GCC，完全不需要 ETH**（消除"每个 NPC 还得备 gas"的麻烦）。
- gas 负担落在 facilitator，且批量、在便宜的 Base 上 → 可持续。

偶发流量的 gas（Base 完全 OK）：捐赠 / 打赏 = 一笔 transfer ~$0.001–0.01；真 agentic wallet（ERC-4337 智能账户）部署 = 一次性 ~$0.01–0.05/个 → × 大量 NPC 才有量（见 §8 决策）。

*数据来源：BaseScan Gas Tracker；L2 sub-$0.03 transfer 统计（2026-05）。*

---

## 7. 架构落点（仍是加接缝，不返工）

`packages/npc-agent` 新增引擎无关的钱包接缝：

```ts
// ports/wallet.ts —— NPC 的经济身份；impl 在宿主侧（OKX / TEE adapter）
interface AgentWallet {
  readonly address: string;
  balanceGcc(): Promise<bigint>;
  // 策略封顶后签 x402 / EIP-3009 授权；payee 必须在白名单内
  authorizeSpend(amountGcc: bigint, payee: string): Promise<PaymentAuthorization>;
}
```

- `SettlementStrategy.X402Nanopayment` 改为**从该 NPC 的 `AgentWallet` 付款**（非全局玩家余额）。
- 支付策略（单次/每日封顶、收款方白名单）在 wallet / smart-account 配置里，**不在可信代码里**。
- `AgentWallet.balanceGcc()` 反馈给 `AiggProvider` 的模型路由（实现 §4 代谢）。
- 依赖方向不变：`game-engine`（OKX/TEE adapter 实现 `AgentWallet`）→ `npc-agent`（只认接口）。

---

## 8. 关键决策

| 决策 | 选项 | 建议 |
|---|---|---|
| **每 NPC 钱包形态** | (A) 真 OKX agentic wallet/每 NPC：自治最强、可链上收任意捐赠，但 gas/运维重；(B) AIGG 账本虚拟 per-NPC GCC 子余额：一个托管钱包，按 npcId 记子余额，简单便宜 | **MVP 用 (B) 跑通代谢闭环；主角级 NPC（酒剑仙）升级 (A) 作 demo 展品。** 同一 `AgentWallet` 接口覆盖两者 |
| **"赚 GCC" 落点** | 链上奖励 vs AIGG 账本记账后结算 | 随 (A)/(B) 决策走 |
| **代谢（余额→模型档位）** | v1 是否启用 | 启用（这是 demo 的可见亮点） |

---

## 9. 待定问题（到集成时定）

- 默认 settlement：先预付余额跑通，还是直接上 nanopayment？（主方向 nano，P0 可先预付、nano 作展示）
- 鉴权：平台 API key vs OKX agent 钱包登录？
- demo 网络：Base 主网 GCC vs Sepolia 测试？
- dev 阶段 `AiggProvider` 先指本地 Ollama 还是直接连 ai.gg？
- 游戏内是否可视化 NPC 的 GCC 余额 / 单次消耗 / 代谢状态？
