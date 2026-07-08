# ai3-inference

Discover, call, **verify**, and settle inference on the AI3 stack (Auto EVM +
DSN) — standalone: no game repo, no platform DB, no live chain required to
prove the full loop.

Extraction plan (task list T1–T10, milestones V1–V3):
[`aigg-src docs/superpowers/plans/2026-07-08-ai3-inference-extraction-plan.md`](https://github.com/jianmliu/aigg-src/blob/main/docs/superpowers/plans/2026-07-08-ai3-inference-extraction-plan.md).
Market design: aigg-src `docs/superpowers/specs/2026-07-05-autoevm-provider-market-design.md`;
fusion: `2026-07-08-fusion-orchestration-design.md`.

> **Interim home.** This directory lives inside `aigg-agent-kit` until the
> standalone repo exists; history moves out with `git subtree split`. It is a
> **self-contained pnpm workspace** — run all commands from this directory.

| Piece | Status |
|---|---|
| `contracts/` — ServiceRegistry + InferenceLedger (moved from aigg-src), deploy scripts, address book | **T2 done** — 7 hermetic specs, local deploy verified |
| `packages/core` — provider/attestation types, tiers, digest reference + vectors | scaffold (T3) |
| `packages/broker` — `autoPalBrokerFromRpc` (from kit npc-agent) | scaffold (T4) |
| `packages/verify` — isomorphic verification, DCAP seam, tier allowlist | scaffold (T5/T6) |
| `packages/voucher` — EIP-712 voucher client half | scaffold (T8) |
| `conformance/` — hermetic harness + grading CLI | scaffold (T7/T9) |

```bash
pnpm install
pnpm -r build                                  # T1 gate
pnpm --filter @ai3-inference/contracts test    # T2 gate: 7 specs
# local deploy check (second terminal: pnpm --filter @ai3-inference/contracts node)
pnpm --filter @ai3-inference/contracts deploy:local
```
