/**
 * @ai3-inference/verify — isomorphic verification (node CLI + browser).
 *
 * Carries the AutoPal attestation client (moved from aigg-agent-kit
 * npc-agent per extraction plan T4): per-response ECDSA verification, the
 * one-time quote binding checks, and the QuoteVerifier DCAP seam. T5/T6 add
 * the imageHash→tier allowlist data and a real DCAP integration; fusion
 * receipt verification lands with the fusion spec's F0.
 */
export const AI3_VERIFY_VERSION = '0.0.1';

export * from './autopal-attestation.js';
