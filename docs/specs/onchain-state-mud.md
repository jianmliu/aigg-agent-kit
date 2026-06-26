# 链上状态层:Lattice MUD ECS（onchain-state-mud）

> 状态:草案 v0.1（2026-06）。配套:`ai-npc-architecture.md`、`npc-economy-and-gcc.md`。
> 关键:这是**第二个 onchain 层**,与已建的 GCC 推理付费层互补。**注意区分:这里的
> "MUD" = Lattice 的 ECS 框架(@latticexyz),不是文字冒险游戏那个 MUD。**

---

## 0. 两层 onchain(都成立,互补)

| 层 | 管什么 | 已建 | 链 |
|---|---|---|---|
| **推理付费层** | NPC "思考"烧 GCC(签名/结算)| ✅ wallet-svc + aigg-facilitator + x402/EIP-3009 | Base(Sepolia 测试)|
| **游戏状态层** | 世界/关系/经济**状态**上链 | 本 spec(MudStore 已建,World 待部署)| 同链,MUD World |

文字 MUD(AI 玩法)与 Lattice MUD(ECS 状态)**合作**:文字 MUD 的状态经已有 `Store`
接缝 → `MudStore` → MUD World 的 ECS 表(链上)。

---

## 1. 桥接:Store 接缝 → MudStore → MUD

`npc-agent` 的 `Store` 当初就为此设计(注释:"v2 MudStore,`{onchain:true}` 子集 → MUD tables")。

- **`MudStore implements Store`**(`@aigg/onchain`,已建 + test:mudstore):
  - 每次 `set` 写入快速/全量的 `local` Store(默认 InMemoryStore,可换 StorageAdapter/IndexedDB);
  - 带 `{ onchain: true }` 的写**额外镜像到 MUD**(经注入式 `MudKvClient`);
  - 读走 `local`(全镜像);`getOnchain()` 读 MUD 上的权威副本。
  - `mudKey(scope,key) = keccak256(scopeKeyId)`,把 (scope×key) 映射成 MUD 的 bytes32 主键。
- **`MudKvClient`** 注入式,保持 kit 框架无关(只用 viem 算 hash)。真实现包一个已部署的
  MUD World(recs/viem `setRecord` 到下面的 `Kv` 表);测试用内存假实现。

哪些 key 会上链(= onchain schema)= 所有用 `{onchain:true}` 写的:关系好感度
(RelationshipMemory)、GCC 账本(GccLedger)、位置/捐赠等。

---

## 2. ECS schema(`contracts/world/mud.config.ts`)

```ts
defineWorld({ namespace: "onchainpal", tables: {
  Kv:        { schema: { key:"bytes32", value:"bytes" },                      key:["key"] },           // MudStore 写这里
  Position:  { schema: { player:"bytes32", room:"bytes32" },                  key:["player"] },
  NpcRoom:   { schema: { npc:"bytes32", room:"bytes32" },                     key:["npc"] },
  Affinity:  { schema: { player:"bytes32", npc:"bytes32", value:"int32" },    key:["player","npc"] },
  GccState:  { schema: { npc:"bytes32", balance:"uint256", spent:"uint256", calls:"uint64" }, key:["npc"] },
  Donation:  { schema: { donor:"bytes32", npc:"bytes32", total:"uint256" },   key:["donor","npc"] },
}})
```

- `Kv` = MudStore 今天写的通用 KV(faithful to the Store seam)。
- 其余是**地道 ECS 表**(目标:供链上逻辑/索引器用)。bytes32 id = keccak(npcId/playerId/roomId 字符串)。
- 与 `npc-identity-and-ownership`(NFT+ERC-6551)对齐:NPC 身份/钱包是 NFT+TBA,这里是
  **可变状态**(位置/关系/余额/捐赠)。

---

## 3. 真部署路径(待办,需 MUD 工具链)

1. 在 `contracts/world` 装 MUD:`@latticexyz/cli @latticexyz/store @latticexyz/world`(对齐已装的 `@latticexyz/recs ^2.2.x`)。
2. `pnpm mud tablegen`(生成 Solidity 表库)+ `pnpm mud worldgen`。
3. 起本地链 `anvil`,`pnpm mud deploy --rpc http://127.0.0.1:8545` → 得到 World 地址。
4. 实现 `MudKvClient`(viem walletClient → World 的 `setRecord/getRecord`,或 recs 同步)指向该 World。
5. 文字 MUD/runtime 用 `new MudStore({ client })` 替换 store → 状态实时上链。
6. 生产可换 Base Sepolia / 主网。

> 现状:`MudStore` + schema + 本 spec 已就绪;**World 已用 mud build/deploy 真部署到本地 anvil(chainId 31337,World `0x0C080e7d6117D2a62D2eeF80632ffA2Eefb3cC87`,6 张 ECS 表全注册)✓**。下一步=实现 MudKvClient 指向该 World,文字 MUD 状态实时上链;生产换 Base Sepolia。
> demo 仍可用本地 Store 跑;`MudStore` 让"状态上链"成为换 client 的一行。
