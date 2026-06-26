# NPC 链上身份与所有权规格（onchainpal）

> 状态：草案 v0.1（2026-05）。归档 NPC 的链上身份/钱包/所有权模型决策。
> 配套：`docs/specs/ai-npc-architecture.md`、`docs/specs/npc-economy-and-gcc.md`。
> 项目记忆：`aigg-gcc-integration`。

---

## 0. 出发问题

每个有 AI 的 NPC，链上该是什么？

- 每个角色一个 **EOA** 钱包？
- 还是每个角色是一个 **NFT**？NFT 能否自己持有 GCC 余额？

**直接结论:** 普通 NFT(ERC-721)本身不能持币;但 **ERC-6551(Token Bound Account, TBA)** 给每个 NFT 绑定一个自己的智能合约账户,那个账户**能持 GCC / ETH / 其它 NFT**。所以"NFT 自己有 GCC 余额" = **能,经 ERC-6551**。推荐模型:**NPC = NFT(身份+所有权+画像)+ ERC-6551 TBA(GCC 钱包)**。

---

## 1. 关键拆分:身份 ≠ 记忆

| 概念 | 粒度 | 落点 |
|---|---|---|
| **NPC 身份 / 钱包**（持 GCC、收捐赠、链上 identity） | **per 角色**（一个酒剑仙，所有玩家共享） | NFT + ERC-6551 TBA（Base） |
| **关系 / 记忆**（好感度、对话史、episodic） | **per (NPC × 玩家)** | 本地 StorageAdapterStore（④）+ DSN 记忆链（AutoDriveStore） |

混淆这两者会把 per-(NPC × 玩家) 也做成钱包 → 数量爆炸。**钱包按角色(共享),记忆按玩家。**

---

## 2. 三种身份模型对比

| | EOA / 角色 | **NFT + ERC-6551 TBA / 角色（推荐）** | 虚拟子账本 |
|---|---|---|---|
| 身份 | 一个地址 | **NFT = 身份 + 所有权 + 画像 metadata** | npcId 字符串 |
| 钱包 / 余额 | EOA 持 GCC | **TBA 持 GCC**（收捐赠 / 付思考 / 锚记忆） | 账本数字 |
| 可拥有 / 交易 | ❌ | **✅ NPC 可被拥有、交易、收藏** | ❌ |
| 密钥管理 | **每 NPC 一个 keypair（几百个，重）** | **不需要 per-NPC 密钥**——NFT 所有者一把钥匙控制名下所有 TBA | 无 |
| 部署成本 | EOA 免费 | **TBA 地址 counterfactual**（注册表确定性算出）→ 用时才 lazy deploy | 无 |
| 链上叙事 | 弱 | **最强:自治、可拥有的经济体** | 无 |

### 为什么 NFT+TBA 比 EOA/角色更干净（不是更重）
1. **控制权收敛**:TBA 由持有该 NFT 的账户控制 → 游戏(或玩家)用**一把控制钥匙**签名/支付名下**所有** NPC 的 TBA。化解"每 NPC 一套密钥"的运维地狱。
2. **零上链成本的长尾**:ERC-6551 TBA 地址确定性,用之前不必部署;第一次花 GCC 时再 lazy deploy。龙套 NPC 不预付任何 gas。
3. **定向捐赠/赚取**:给某 NPC 捐 GCC = 往它 TBA 地址转账;NPC 赚的 GCC 留在自己 TBA。
4. **可组合**:TBA 还能持有该 NPC 的物品、记忆 NFT 等。

> EOA/角色 只在"一次性原型"里更简单;一旦要所有权、可交易、捐赠、可组合,NFT+TBA 才是干净的目标。

---

## 3. 真正的产品决策:谁拥有 NPC 的 NFT?

NFT 化引出的核心决策(产品/经济,非技术):

| 拥有者 | 含义 | 取舍 |
|---|---|---|
| **游戏自持** | NPC 是游戏资产;玩家通过捐 GCC"赞助" | 最简单;无二级市场/合规负担 |
| **玩家 / 赞助者拥有** | NPC 成为可收藏/交易资产;玩家"养"一个酒剑仙、充 GCC、它有记忆会赚 | 最有冲击力的 crypto-native 玩法;但二级市场/定价/合规最重 |
| **混合** | hero NPC 可被拥有,龙套游戏自持 | demo 友好;兼顾叙事与简单 |

> 这是需要先拍板的决策——它决定 NFT 合约的 mint/转移策略与经济设计,但**不影响 `AgentWallet` 抽象**(见 §5)。

---

## 4. 链落点

| 组件 | 链 | 说明 |
|---|---|---|
| NPC NFT collection + ERC-6551 registry/account | **Base** | GCC 的家;TBA 持 GCC、签 x402 nanopayment |
| GCC 余额 / 思考付费 | Base（经 AIGG/ai.gg） | 见 `npc-economy-and-gcc.md` |
| 记忆永存 / CID 锚定（auto-respawn）| **Autonomys**（Taurus EVM + DSN） | 见 `aigg-gcc-integration` |

双链各司其职:Base 管"算力消耗与身份钱包",Autonomys 管"永久记忆"。

---

## 5. 架构不锁死:AgentWallet 抽象覆盖三者

`@aigg/npc-agent` 的 `AgentWallet` 接缝(`address` / `balanceGcc()` / `authorizeSpend()`)对大脑隐藏了实现。它可由以下任一支撑:

- **虚拟子账本**(游戏金库 + npcId 子余额)——最轻,demo 起步。
- **EOA / 角色**——简单真钱包。
- **ERC-6551 TBA / 角色**——产品目标(身份+所有权+钱包)。

因此**可分阶段**:demo 先虚拟/EOA 跑通经济闭环,产品目标锁定 NFT+ERC-6551 TBA,**Agent 大脑、PalAgentAdapter、startPalNpcAgents 一行不动**。这正是当初切 `AgentWallet` 接缝的意义。

---

## 6. 推荐路径

1. **Demo**:`AgentWallet` 用虚拟子账本(或给 3 个 hero NPC EOA),把"思考消耗 GCC + 定向捐赠 + 认知代谢"闭环跑通(经 ai.gg)。
2. **产品**:hero/具名 NPC 升级为 **NFT + ERC-6551 TBA**(Base);TBA 持 GCC、收捐赠、签 x402;长尾保留虚拟子账本或按需 lazy-mint。
3. **所有权**:先定 §3 的拥有者模型(建议混合);据此设计 NFT mint/转移。
4. **记忆锚定**:hero NPC 的记忆链 head CID 经 auto-respawn 锚定到 Autonomys(可选,见经济 spec)。

---

## 7. 待定决策

- 谁拥有 NPC NFT(§3)?——先拍板。
- ERC-6551 实现:用 tokenbound 标准实现还是自定义 registry/account?
- TBA 的控制密钥托管(游戏服务钱包 / TEE / 玩家钱包)?
- hero NPC 名单与"可拥有"边界(哪些 NPC 上 NFT)。
- 画像 metadata 上链方式(tokenURI 指向 Auto Drive CID?——内容永存与身份合一)。
