# ai3-inference

Discover, call, **verify**, and settle inference on the AI3 stack (Auto EVM +
DSN) — standalone: no game repo, no platform DB, no live chain required to
prove the full loop.

Extraction plan (task list T1–T10, milestones V1–V3):
[`aigg-src docs/superpowers/plans/2026-07-08-ai3-inference-extraction-plan.md`](https://github.com/jianmliu/aigg-src/blob/main/docs/superpowers/plans/2026-07-08-ai3-inference-extraction-plan.md).
Market design: aigg-src `docs/superpowers/specs/2026-07-05-autoevm-provider-market-design.md`;
fusion: `2026-07-08-fusion-orchestration-design.md`.

> **Homes.** Standalone repo: <https://github.com/jianmliu/ai3-inference>
> (private), populated via `git subtree split --prefix=ai3-inference` from
> `aigg-agent-kit`. This in-kit copy remains the WORKING interim home while
> consumers resolve `@ai3-inference/*` through the kit workspace — develop
> here, sync the standalone repo with another subtree split/push. The
> direction flips (standalone becomes canonical, kit consumes a published
> package) at plan T10. It is a **self-contained pnpm workspace** — run all
> commands from this directory.

| Piece | Status |
|---|---|
| `contracts/` — ServiceRegistry + InferenceLedger (moved from aigg-src), deploy scripts, address book | **T2 done** — 7 hermetic specs, local deploy verified |
| `packages/core` — provider/attestation types, tiers, digest reference + vectors | **T3 done** — 9 TS vector tests + Go companion test in aigg-src both green |
| `packages/broker` — `autoInfBrokerFromRpc` (moved from kit npc-agent) | **T4 done** — kit re-exports; npc-agent + gamekit smokes green; `requireVerified` hard-fails without a quote verifier (T5) |
| `packages/verify` — attestation client, tamper matrix, imageHash→tier allowlist, DCAP verifiers | **T5+T6 done** — browser-safe (guard-tested); `UNSAFE_acceptAnyQuote` rename; allowlist enforced in `verifyQuoteOnce` (unknown images fail closed to T1); DCAP behind the `QuoteVerifier` seam: dcap-qvl wasm (preferred, isomorphic) + `httpQuoteVerifier` fallback (Go service in aigg-src), real known-good/bad TDX quote fixtures |
| `packages/voucher` — EIP-712 voucher client half | scaffold (T8) |
| `conformance/` — hermetic harness + grading CLI | scaffold (T7/T9) |

```bash
pnpm install
pnpm -r build                                  # T1 gate
pnpm -r test                                   # core vectors + verify tamper/allowlist/DCAP + broker + 7 contract specs
pnpm --filter @ai3-inference/contracts test    # T2 gate only: 7 specs
# local deploy check (second terminal: pnpm --filter @ai3-inference/contracts node)
pnpm --filter @ai3-inference/contracts deploy:local
```
