# kit — AI NPC agent runtime + on-chain economy (reusable)

The **engine-neutral, game-agnostic** core extracted from
[onchainpal](../). Zero PAL / game dependencies — drop it into any game or agent
app that wants AI NPCs with on-chain identity and GCC-metered "thinking".

It lives inside the onchainpal monorepo today, grouped under this single `kit/`
prefix so it can be split into its **own repo** with one command and consumed
back via git submodule:

```bash
git subtree split --prefix=kit -b kit-split
# push kit-split to the new repo; then in onchainpal:
git submodule add <new-repo-url> kit
```

## Layout

| Path | What |
|---|---|
| `packages/npc-agent` | **core brain** — structured intent/effect, tiered memory, `Store`/`InferenceProvider`/`AgentWallet`/`SettlementStrategy` seams, `LlmAgent`+runtime, persona, GccLedger, cognitive Metabolism. Browser-safe, dependency-light. |
| `packages/onchain` | **wallet + settlement** — per-agent EOA (BIP-44), ERC-6551 TBA wallets, x402/EIP-3009 GCC settlement, AIGG facilitator client. Node/service-side (viem, holds keys). |
| `proxy` | **inference-proxy** — server hop so a browser can drive GCC-consuming inference without holding the gateway token; per-NPC ledger + donation indexer. Zero-dep Node. |
| `contracts/onchainpal-nfts` | **NFT contract** — `OnchainPalNPC` ERC-721 (each NPC a token; ERC-6551 TBA = its wallet) + Foundry deploy script. |
| `docs/specs` | design specs (architecture, economy/GCC, identity/ownership, AIGG integration). |

## What stays in the host game (onchainpal)

The PAL-specific skin: card→persona mapping, the PAL dialog adapter, the PAL NPC
runtime wiring, bootstrap, the dev autopilot, PAL storage adapter, the game
engine + playground. Those implement the kit's ports; the kit never depends on
them.

## Tests

```bash
pnpm --filter @aigg/npc-agent test:smoke
pnpm --filter @aigg/npc-agent test:metabolism
pnpm --filter @aigg/onchain   test:tba
pnpm --filter @aigg/onchain   test:facilitator
pnpm --filter @aigg/inference-proxy smoke:donations
( cd contracts/onchainpal-nfts && forge test )
```
