/**
 * MOVED (extraction plan T3/T4) → @ai3-inference/core.
 *
 * The InferenceProvider seam and its attestation/usage types now live in the
 * standalone ai3-inference library (canonical home:
 * ai3-inference/packages/core/src/provider.ts — same shapes, richer docs, plus
 * the verifiability tier taxonomy and the digest reference implementation).
 * This shim keeps every './provider' import inside the kit and the
 * @aigg/npc-agent public API working unchanged.
 */
export type {
  InferenceRequest,
  Attestation,
  InferenceUsage,
  InferenceResult,
  InferenceProvider,
} from '@ai3-inference/core';
