/**
 * imageHash→tier allowlist — THE VERSIONED DATA FILE (fusion spec
 * 2026-07-08 §2.1, extraction plan T5). This file is data, versioned with
 * the library: every change to `entries` MUST bump `version` (and is
 * reviewed like a trust decision — v0 governance: repository maintainers,
 * fusion spec §13.3).
 *
 * Semantics: an image measurement identifies exactly which CVM compose ran
 * (dstack extends the app compose hash into RTMR3; `extractImageMeasurement`
 * reads it from the quote). The measurement's entry caps the `verifiability`
 * tier the service may claim:
 *
 *   • unknown measurement → `defaultMaxTier` = T1 `dstack-cvm-relay`
 *     (FAIL CLOSED — nothing above sealed-relay without an explicit grant);
 *   • a T2 grant requires the compose to provably contain the local serving
 *     stack and NO upstream relay egress for the listed models;
 *   • a T3 grant is the fusion orchestrator compose.
 *
 * Both sides enforce the same map: the gateway's publisher refuses to boot
 * with a label above its image's ceiling, and clients re-check inside
 * `verifyQuoteOnce` — a lying label fails verification even if an operator
 * patches their publisher.
 *
 * v1 ships EMPTY: no T2/T3 image exists yet (T2 serving compose and the
 * fusion orchestrator are future milestones). Every live service is
 * therefore capped at `dstack-cvm-relay`, which is exactly today's honest
 * boundary.
 */
import type { VerifiabilityTier } from '@ai3-inference/core';

export interface ImageTierAllowlistEntry {
  /** hex image measurement (0x optional, case-insensitive; dstack: RTMR3). */
  imageHash: string;
  /** the highest verifiability tier this image may claim. */
  maxTier: VerifiabilityTier;
  /** human note: which compose this is and why it earned the tier. */
  note?: string;
}

export interface ImageTierAllowlist {
  /** bump on EVERY entries change. */
  version: number;
  /** ceiling for measurements not listed — fail closed. */
  defaultMaxTier: VerifiabilityTier;
  entries: ImageTierAllowlistEntry[];
}

export const IMAGE_TIER_ALLOWLIST_VERSION = 1;

export const IMAGE_TIER_ALLOWLIST: ImageTierAllowlist = {
  version: IMAGE_TIER_ALLOWLIST_VERSION,
  defaultMaxTier: 'dstack-cvm-relay',
  entries: [
    // { imageHash: '0x<96 hex chars — RTMR3 of the vllm serving compose>',
    //   maxTier: 'dstack-cvm-inference',
    //   note: 'dstack-vllm-<model>-<date>: local serving, no upstream egress' },
  ],
};
