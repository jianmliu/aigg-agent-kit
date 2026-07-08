/**
 * Verifiability tiers — the closed taxonomy of what an attestation proves
 * (fusion spec 2026-07-08 §2). The ServiceRegistry `verifiability` string
 * must be one of these labels; publishers and clients both validate, and the
 * imageHash→maxTier allowlist (shipped with @ai3-inference/verify) caps what
 * a given CVM image may claim.
 *
 * | tier | label                 | attestation proves                      |
 * |------|-----------------------|-----------------------------------------|
 * | T0   | scripted              | nothing — never listed on-chain         |
 * | T1   | dstack-cvm-relay      | faithful relay, credential secrecy      |
 * | T2   | dstack-cvm-inference  | the inference itself (model in-enclave) |
 * | T3   | dstack-cvm-fusion     | the orchestration trace + per-node tier |
 */
export const VERIFIABILITY_TIERS = [
  'scripted',
  'dstack-cvm-relay',
  'dstack-cvm-inference',
  'dstack-cvm-fusion',
] as const;

export type VerifiabilityTier = (typeof VERIFIABILITY_TIERS)[number];

export function isVerifiabilityTier(label: string): label is VerifiabilityTier {
  return (VERIFIABILITY_TIERS as readonly string[]).includes(label);
}

/** Rank for ceiling comparisons: scripted=0 … fusion=3. */
export function tierRank(tier: VerifiabilityTier): 0 | 1 | 2 | 3 {
  return VERIFIABILITY_TIERS.indexOf(tier) as 0 | 1 | 2 | 3;
}

/**
 * True iff `claimed` is within the ceiling `maxTier` allows. Unknown labels
 * are NEVER within any ceiling (fail closed) — mirrors the publisher's
 * capability guard.
 */
export function tierWithinCeiling(claimed: string, maxTier: VerifiabilityTier): boolean {
  if (!isVerifiabilityTier(claimed)) return false;
  return tierRank(claimed) <= tierRank(maxTier);
}
