# onchainpal-world

**KvWorld** — the global, mutable **head-CID index** for the cross-server NPC
world (PR-B). Writes are gated to an owner-managed **writer allowlist**
(security C1 — prevents arbitrary overwrite of the shared world); **reads are
public**. ai.gg-operated trust model for this stage; permissionless per-key-owner
federation is a later design.

Deployed (Base Sepolia): `0x02c1b66e8c8e20617253833420EC94C46eFE8d02` (v2, gated).

## Why

Cross-server federation needs one shared, mutable pointer store: the "current
head CID" per `(scope,key)`. Content-addressed blobs (NPC identity/memory) live
in the global DSN — reachable by CID from any server — but DSN is **immutable**,
so it cannot hold the *moving* head pointer. That pointer must be globally
readable **and** writable; on-chain is the only trustless option. Any mud-server
instance reading the same `KvWorld` sees the same heads.

It's a **minimal KV**, not a full latticexyz ECS World: the kit's
`MudWorldKvClient` only needs `World.call(systemId, kvSet|kvDel)` for writes and
`getRecord(tableId,[key])` for reads, passing the MUD routing ids as opaque
args. KvWorld implements exactly that ABI as a minimal, auditable, swap-in KV
with a writer allowlist. (Deploy a real latticexyz World later if ECS tooling is
wanted; the client is unchanged.)

After deploy, authorize the world-writer EOA(s) (e.g. the wallet-svc-held key):
`setWriter(<writer>, true)` (owner-only). The deployer is the owner + first writer.

## Tiering invariant

Only the **stable, cross-server subset** — NPC identity/registry + their DSN head
CIDs — is written here. **Hot** per-visitor state (relationships, GCC balance)
stays in each server's local warm tier and is snapshotted to the shared tier only
at milestones, so routine conversation never costs a transaction. (Enforced at
the store layer, not the contract.)

## Build / test

```bash
forge build

# live cross-server round-trip (anvil):
anvil --silent &
forge create src/KvWorld.sol:KvWorld --rpc-url http://127.0.0.1:8545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 --broadcast
WORLD=<deployed> RPC_URL=http://127.0.0.1:8545 \
  PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  pnpm --filter @aigg/onchain test:kvworld-live
```

## Deploy

```bash
# Base Sepolia (staging — real shared chain for true cross-server federation;
# OnchainPalNPC NFT + testnet GCC already live here):
forge create src/KvWorld.sol:KvWorld --rpc-url https://sepolia.base.org \
  --private-key $DEPLOYER_PK --broadcast

# Base mainnet (production — after Sepolia validation + security review):
forge create src/KvWorld.sol:KvWorld --rpc-url https://mainnet.base.org \
  --private-key $DEPLOYER_PK --broadcast
```

Then point each mud-server at it: `WORLD=<addr> RPC_URL=<base rpc> PRIVATE_KEY=<gas key>`.
