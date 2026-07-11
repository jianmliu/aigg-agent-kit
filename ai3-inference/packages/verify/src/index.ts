/**
 * @ai3-inference/verify — isomorphic verification (node CLI + browser).
 *
 * Carries the AutoInf attestation client (moved from aigg-agent-kit
 * npc-agent per extraction plan T4): per-response ECDSA verification, the
 * one-time quote binding checks, and the QuoteVerifier DCAP seam. T5 adds
 * the versioned imageHash→tier allowlist (enforced in verifyQuoteOnce) and
 * the browser-safety guarantee (no node-only APIs in shipped modules); T6
 * adds real DCAP verifiers behind the seam; fusion receipt verification
 * lands with the fusion spec's F0.
 */
export const AI3_VERIFY_VERSION = '0.0.1';

export * from './autoinf-attestation.js';
export * from './image-tier-allowlist.js';
export * from './dcap.js';
