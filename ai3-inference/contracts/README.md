# @ai3-inference/contracts — Auto EVM provider market

Canonical home of the market contracts, **moved verbatim from aigg-src
`contracts/src/market/`** per the extraction plan (aigg-src keeps a pointer).
Design spec: aigg-src `docs/superpowers/specs/2026-07-05-autoevm-provider-market-design.md`.

## Contracts (v0 — native AI3, no staking/slashing; decisions ratified 2026-07-05)

| Contract | Role (0G-coupling analogue) | Parameters |
|---|---|---|
| `src/market/ServiceRegistry.sol` | ① on-chain listing: provider → models, endpoint, wei-of-AI3 per-token prices, attested enclave signer + quote hash (blob on DSN; verification client-side). | `bondWei` — flat refundable listing bond, **immutable at deploy** (default 0.1 AI3 via `AI3_REGISTRY_BOND`); 0 disables. |
| `src/market/InferenceLedger.sol` | ②+③ prepaid escrow (per-(user,provider) sub-accounts) + EIP-712 voucher batch settlement (nonce bitmap, maxFee cap, expiry). | `REFUND_UNLOCK` — 24h constant; funds stay settleable through the window. EIP-712 domain `AIGGInferenceLedger` v1. |

## Test

```bash
pnpm install && pnpm test     # hardhat harness — 7 specs: bond/update/deactivate/paging,
                              # full settle path, 6 rejection paths, refund-window semantics
```

## Deploy

```bash
# local gate (terminal 1: `pnpm node` — hardhat node or anvil on :8545)
pnpm deploy:local

# Chronos testnet (chainId 8700, tAI3) → mainnet (870, AI3)
AI3_DEPLOYER_KEY=0x… pnpm deploy:chronos
AI3_DEPLOYER_KEY=0x… AI3_REGISTRY_BOND=0.1 pnpm deploy:mainnet
```

The script pins an explicit `gasPrice` + `type: 0` on every send — **Auto EVM
accepts legacy transactions only**. Deployed addresses are recorded in
[`addresses.json`](addresses.json) keyed by chainId (live-network entries are
committed; local-chain entries are not).

`foundry.toml` targets the same sources for forge users; `.t.sol` ports remain
a welcome follow-up.

## Status

Hermetically tested, **not yet deployed and not audited**. Deployment order:
Chronos first, then mainnet.
