# AIGG ↔ onchainpal 对接规格

> 状态：草案 v0.1（2026-06）。**受众：AIGG（AI.GG / p2papi）团队。**
> 目的：说明 onchainpal 如何把 NPC 推理与 GCC 消耗接入 AIGG，**AIGG 需要提供/暴露什么**，
> 以及双方的接口契约。
> 参考：AIGG `docs/superpowers/specs/2026-05-31-x402-permit2-agent-wallet-design.md`、
> onchainpal `docs/specs/{ai-npc-architecture,npc-economy-and-gcc,npc-identity-and-ownership}.md`。

---

## 1. 一句话

**onchainpal 是一个 AI NPC 怀旧 RPG;每个 NPC 的"思考"是一次 LLM 推理,经 AIGG 网关进行、消耗 GCC。** onchainpal 已把推理/钱包/结算/计量都做成可插拔接缝(`@aigg/npc-agent`),**只需 AIGG 在几个明确的点对接**。Demo 起步:**AIGG 全额出资 GCC**(AIGG 持 funding EOA + 授权 agent),onchainpal 只触发推理 + per-NPC 计量。

---

## 2. 接缝对齐（双方各自负责什么）

```
            onchainpal（@aigg/npc-agent + game-engine）         │   AIGG（ai.gg / p2papi 后端）
─────────────────────────────────────────────────────────────────────┼──────────────────────────────────────
 NPC 思考 → InferenceProvider.complete(prompt) ──── Anthropic API ────▶│  ai.gg 网关（ANTHROPIC_BASE_URL=www.ai.gg）
                                              ◀──── { text, usage } ───│  路由到上游 Claude;按 gcc_pricing 计费扣 GCC
 SettlementStrategy.settle(npcId, usage)                               │
   ├─ LedgerSettlement（demo）→ GccLedger（per-NPC 计量,本地持久）    │  （余额已在网关侧被扣）
   └─ X402GccSettlement（真链上）                                      │
        AgentWallet(per-NPC EOA).signTypedData(GCC EIP-2612 Permit) ──▶│  aigg-facilitator 提交 permit()+transferFrom
 AgentWallet ≡ AIGG X402PaymentSigner（签名人,不持资金）              │  funding EOA 持 GCC;Permit2 授权 agent
```

**职责划分**：
- **onchainpal**：触发推理、构造并签名 x402 GCC 支付(用 per-NPC EOA)、per-NPC 计量(GccLedger)、NPC 身份/画像/记忆。
- **AIGG**：推理网关 + 计费、funding EOA(持 GCC)、scoped agent 授权(Permit2)、facilitator 链上提交。

---

## 3. AIGG 需要提供/暴露什么（核心 asks）

### A. 推理端点（已可用,确认即可）
- **Anthropic 兼容**端点(`ANTHROPIC_BASE_URL=https://www.ai.gg`,`ANTHROPIC_AUTH_TOKEN` Bearer)。onchainpal 用官方 `@anthropic-ai/sdk` 调用。**已验证可用**(经 ai.gg 用结构化输出生成 NPC 卡)。
- 需确认支持:**structured outputs**(`output_config.format` JSON Schema)、**adaptive thinking**、**effort**;模型可用性(`claude-opus-4-8` 等,及廉价档如 DeepSeek/Haiku 用于 ambient 对话)。
- **每模型 GCC 价**:暴露 `gcc_pricing`(每模型 input/output 每百万 token 的 GCC 乘数),让 onchainpal 能本地估算并对账。

### B. ⭐ 每次调用的真实 GCC 成本（最重要的 ask）
onchainpal 的 `GccLedger` 要按 NPC 累计**真实**消耗。目前我们只能用 `tokens × 本地乘数`估算。请提供以下任一:
1. **响应头/字段**:每次 `/v1/messages` 返回里带 `gcc_cost`(如响应头 `x-aigg-gcc-cost` 或 usage 扩展字段);**首选**。
2. **用量查询 API**:按 request-id 或时间窗查询已扣 GCC。
3. 至少:稳定的 `gcc_pricing` 表 + 响应里的 token usage(我们自算)。

### C. 账户与鉴权（demo 出资模型）
- onchainpal 作为**一个 AIGG user**:一个 server 端 `ANTHROPIC_AUTH_TOKEN` + 一个 **funding EOA 持 GCC**(AIGG 出资/充值)。请说明:
  - 如何为该游戏账户**充值 GCC**(x402 GCC 直充 / CCA / 手动)。
  - token 轮换 / scope。
- **安全**:AUTH_TOKEN 只在 onchainpal 服务端;**不进浏览器**。浏览器 live 走 onchainpal 自建代理(服务端持 token)→ ai.gg。AIGG 若能提供**短期浏览器 session token**(限额/限时)可省去代理,请说明。

### ⭐ D-bis. facilitator 真实测试(2026-06):AIGG 侧需对齐 chain/合约
onchainpal 端的 x402 客户端已对齐 facilitator wire(`POST /verify`+`POST /settle`,`{paymentPayload, paymentRequirements}`,Bearer auth;EIP-3009 `TransferWithAuthorization`)并完成 headless 验证(`pnpm test:facilitator`,真签名验签通过)。

**实测 node2 `140.143.30.201:18081`(token 由 AIGG 提供后)**:
- ✅ `GET /supported` 返回正常,`scheme=exact`、**`network=eip155:84532`(Base Sepolia)**、signer `0x30B1…26b26`。
- ✅ `POST /verify` 鉴权通过(token 工作);facilitator 收到 onchainpal 构造的 payload。
- ❌ verify 拒绝:`invalidReason: "no_facilitator_for_network"`,因为 onchainpal 按 handoff 文档把 payload 标成 `eip155:8453`(主网),而 facilitator 只注册了 Sepolia。

**根因(已用 RPC 实证)**:
- handoff 文档 `2026-05-28-gcc-rebrand-cutover-handoff.md` 列 GCC ERC-20 = `0x135f…7779` "Base mainnet";Base mainnet `eth_getCode` 返回 12230 字节 bytecode ✅ —— 合约**在主网**。
- node2 facilitator `.env`: `CHAIN_ID=84532`、`RPC_URL=https://sepolia.base.org` —— facilitator **接的是 Sepolia testnet**。
- Sepolia 上 `0x135f…7779` `eth_getCode` = `0x`(空)—— **Sepolia 上没有 GCC 合约**。

**给 AIGG 的明确选择(两条路任一)**:
1. **把 GCC 在 Sepolia 上也部署一份**(测试合约,真 dry-run 用),把那个地址告诉我们 → onchainpal 改 `asset` 为 Sepolia 版,真 `/verify` 立即通(facilitator 已是 Sepolia)。
2. **把 node2 facilitator 切到 Base 主网**(改 `RPC_URL=https://mainnet.base.org`、`CHAIN_ID=8453`)→ 直接对生产 GCC 验证;但任何 `/settle` 都会真烧 GCC+gas,慎重。

**安全 dry-run 推荐 = 路径 1**(Sepolia 部署一份测试 GCC,我们的 verify-only 路径就能完整跑通,且零真金钱风险)。

> onchainpal 这边的 `verify:facilitator` 工具已就绪(`pnpm --filter @onchainpal/game-engine verify:facilitator`,env 注入 URL/token/mnemonic),AIGG 解决上面之一后即可一次性 dry-run。

### D. 真链上结算（x402,post-demo)
当从"AIGG 出资记账"升级到"per-NPC EOA 真签真扣"时,onchainpal 已能产出签名,需 AIGG 提供:
- **facilitator 端点契约**:接收下面 §4 的 `GccPermitPayment`(GCC EIP-2612)/ Permit2 payload 的 HTTP 接口(URL、请求/响应 schema、错误码)。
- **funding EOA 如何授权 onchainpal 的 per-NPC agent EOA**:onchainpal 会提供一组 **per-NPC EOA 地址**(BIP-44 派生,见 §4);AIGG 的 funding EOA 对这些 spender 签 **Permit2 PermitSingle**(token=GCC、maxAmount、expiry)。需要双方约定:谁派生、谁授权、scope 参数。
- **nonce 读取**:`GCC.nonces(owner)`(EIP-2612)/ Permit2 nonce —— AIGG 提供 RPC 端点或代读接口。
- **GCC 合约 / facilitator / seller 地址 + chainId**(Base 主网 / Sepolia)。

### E. 可选
- **per-NPC 子账户/限额**:AIGG 是否支持把每个 NPC 注册为子 agent(独立限额/计费)?若否,onchainpal 用虚拟子账本(已实现)。
- **推理 attestation**:AIGG 是否能返回签名的推理证明(model + prompt/response hash)?onchainpal 已预留 `Attestation` 字段,用于"NPC 想了什么、烧了多少 GCC"的可证明溯源。

---

## 4. onchainpal 提供的接口/数据（AIGG 对接面）

onchainpal 侧已实现的接缝(`@aigg/npc-agent`),AIGG 实现对应一侧即可:

```ts
// 推理:AIGG = Anthropic 兼容端点;onchainpal 用 SDK 调用并读 usage
interface InferenceResult { text: string; usage?: { model; inputTokens; outputTokens; gccCost }; attestation?: ... }

// 钱包/签名:AgentWallet ≡ AIGG X402PaymentSigner（签名人,不持资金）
interface AgentWallet { address: string; balanceGcc(): Promise<bigint|null>; signTypedData(payload): Promise<`0x${string}`> }

// 结算:onchainpal 构造并签名,提交给 AIGG facilitator
interface GccPermitPayment {   // GCC EIP-2612 path（GCC.sol 为 ERC20Permit）
  scheme: 'eip2612'; chainId; token; owner;        // owner = per-NPC EOA 地址
  spender;                                         // = AIGG seller 地址
  value;                                           // GCC 原子数
  nonce; deadline; signature;                      // EIP-712 签名(验签回 owner)
}
```

- **per-NPC EOA 地址**:onchainpal 从一个 master seed BIP-44 派生 `m/44'/60'/0'/0/<uint31(keccak(npcId))>`,每个 NPC 一个确定性地址。可导出地址清单交 AIGG 做 Permit2 授权。
- **GCC EIP-2612 Permit** 的 EIP-712 shape 已按 AIGG spec §3.1.2 实现并验签通过。

---

## 5. 分阶段对接

| 阶段 | onchainpal | AIGG 需提供 | 结算 |
|---|---|---|---|
| **P0 Demo（现在）** | 触发推理(ai.gg)+ per-NPC GccLedger 计量 | 推理端点 + 账户 token + funding GCC 余额 +（理想）每调用 gcc_cost | `LedgerSettlement`（网关扣费 + 本地计量） |
| **P1 真实计量** | GccLedger 用真实 gcc_cost | §3B 真实成本反馈 | 同上,数字变真 |
| **P2 真链上结算** | per-NPC EOA 签 GCC EIP-2612 → 提交 facilitator | §3D facilitator 端点 + Permit2 授权 + nonce + 地址 | `X402GccSettlement`（链上扣 GCC） |
| **P3 所有权/捐赠** | NPC=NFT + ERC-6551 TBA 持 GCC | 智能账户签名(EIP-1271)兼容 facilitator | TBA 出资,scoped 签名人 |

---

## 6. 给 AIGG 的明确问题（待答复）

1. **每次推理的真实 GCC 成本**怎么拿(响应头 / 字段 / 查询 API)?——P1 的关键。
2. ai.gg 的 Anthropic 端点是否支持 `output_config.format`(结构化输出)/ adaptive thinking / effort?有哪些模型 + 各自 GCC 价?
3. 游戏账户如何**充值/出资 GCC**?token 轮换策略?
4. facilitator 的 **HTTP 契约**(接收 GccPermitPayment / Permit2 的 endpoint、schema)?
5. funding EOA 如何对 onchainpal 的 **per-NPC agent EOA 地址**签 Permit2 PermitSingle(谁派生、谁授权、scope)?
6. 是否提供 **nonce 代读** 与 **GCC/seller/facilitator 地址 + 网络**(主网/Sepolia)?
7. 浏览器场景:是否提供**短期受限 session token**,还是 onchainpal 自建服务端代理?
8. 是否支持 **per-NPC 子 agent 注册**(独立限额/计费)与**推理 attestation**?

---

## 7. 当前可立即联调的最小回路（P0）

```
onchainpal 服务端(持 ANTHROPIC_AUTH_TOKEN)
  → ai.gg /v1/messages(NPC 思考)
  → 返回 text + usage
  → GccLedger.record(npcId, usage)   // per-NPC 计量
GCC 实际扣减发生在 ai.gg 侧(AIGG funding 账户)
```
这一步 onchainpal 已就绪,**只等 AIGG 确认账户/token + funding GCC 余额**(理想再加每调用 gcc_cost 反馈)。
