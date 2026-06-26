# @aigg/onchain

Engine-neutral **on-chain economy kit for AI agents** — the reusable "wallet +
settlement" half of the NPC agent stack. Sits on top of
[`@aigg/npc-agent`](../npc-agent)'s `AgentWallet` / `SettlementStrategy`
seams. **Zero game / PAL dependencies** — usable by any agent app that wants
per-agent on-chain identity + GCC payments.

> Node / service-side: it holds key material and uses `viem`. Don't import it into
> a browser bundle — the browser drives inference through the proxy and reads
> balances via RPC. (This package is intentionally not part of `@aigg/npc-agent`,
> which stays browser-safe and dependency-light.)

## What's in it

| Module | Role |
|---|---|
| `EoaAgentWallet` (`agent-eoa`) | per-agent **EOA**, BIP-44 derived from one master mnemonic (`m/44'/60'/0'/0/<uint31(keccak(npcId))>`). Each agent gets a deterministic address; signs EIP-712. |
| `computeTbaAddress` / `TbaAgentWallet` (`tba`) | **ERC-6551 Token Bound Account** — the agent NFT's wallet (holds GCC, receives donations). Counterfactual address (no deploy to know it); verified against the live registry. |
| `AiggFacilitatorClient` | client for the standard x402 facilitator (`/supported`, `/verify`, `/settle`). |
| `X402GccEip3009Settlement` | builds the x402 v2 `PaymentPayload`+`PaymentRequirements` (EIP-3009 `TransferWithAuthorization`) and verifies/settles via the facilitator. |
| `X402GccSettlement` | EIP-2612 `permit()` variant. |

## Tests

```bash
pnpm --filter @aigg/onchain test:eoa
pnpm --filter @aigg/onchain test:tba          # TBA addr == live registry
pnpm --filter @aigg/onchain test:settlement
pnpm --filter @aigg/onchain test:facilitator  # exact x402 wire + sig verify
```

## Tools

```bash
# real /verify against an AIGG facilitator (no on-chain tx)
AIGG_FACILITATOR_URL=… AIGG_FACILITATOR_TOKEN=… NPC_MNEMONIC=… \
  pnpm --filter @aigg/onchain verify:facilitator

# print each NPC's TBA address + live GCC balance
NFT_ADDRESS=0x… pnpm --filter @aigg/onchain show:tba
```

## Reuse / extraction

Part of the planned standalone "AI NPC agent + on-chain economy kit" repo
(`npc-agent` core + this + the `inference-proxy` + the `onchainpal-nfts`
contracts). This package + `npc-agent` are PAL-free by design, so the eventual
`git subtree split` → submodule is mechanical. See `docs/specs/`.
