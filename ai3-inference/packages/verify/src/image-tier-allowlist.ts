/**
 * imageHash→tier allowlist — lookup + enforcement (fusion spec §2.1). The
 * data itself lives in ./image-tier-allowlist.data.ts (versioned with the
 * library); this module is the pure logic both the client verifier
 * (`verifyQuoteOnce`) and any publisher-side check share.
 */
import { tierWithinCeiling, type VerifiabilityTier } from '@ai3-inference/core';
import {
  IMAGE_TIER_ALLOWLIST,
  type ImageTierAllowlist,
  type ImageTierAllowlistEntry,
} from './image-tier-allowlist.data.js';

export { IMAGE_TIER_ALLOWLIST, IMAGE_TIER_ALLOWLIST_VERSION } from './image-tier-allowlist.data.js';
export type { ImageTierAllowlist, ImageTierAllowlistEntry } from './image-tier-allowlist.data.js';

/** canonical form for measurement comparison: no 0x, lowercase. */
function normalizeHash(h: string): string {
  return (h.startsWith('0x') || h.startsWith('0X') ? h.slice(2) : h).toLowerCase();
}

/**
 * maxTierForImage — the verifiability ceiling for an image measurement.
 * Unknown measurements get the allowlist's `defaultMaxTier` (T1) — FAIL
 * CLOSED: absence of a grant is a cap, never an allowance.
 */
export function maxTierForImage(
  imageHash: string,
  allowlist: ImageTierAllowlist = IMAGE_TIER_ALLOWLIST,
): VerifiabilityTier {
  const key = normalizeHash(imageHash);
  const hit = allowlist.entries.find((e) => normalizeHash(e.imageHash) === key);
  return hit ? hit.maxTier : allowlist.defaultMaxTier;
}

/**
 * assertTierAllowedForImage — throws unless `claimed` is a known tier label
 * within the image's ceiling. Free-form labels always throw (the taxonomy is
 * a closed enum); labels above the ceiling throw (a lying label must fail
 * verification even if the operator patched their publisher).
 */
export function assertTierAllowedForImage(
  claimed: string,
  imageHash: string,
  allowlist: ImageTierAllowlist = IMAGE_TIER_ALLOWLIST,
): void {
  const ceiling = maxTierForImage(imageHash, allowlist);
  if (!tierWithinCeiling(claimed, ceiling)) {
    throw new Error(
      `[autoinf-attest] verifiability tier '${claimed}' exceeds the image allowlist ceiling ` +
        `'${ceiling}' for measurement ${imageHash} (allowlist v${allowlist.version}; ` +
        `unknown images fail closed to '${allowlist.defaultMaxTier}')`,
    );
  }
}
