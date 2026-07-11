/**
 * @ai3-inference/core — shared types for the AI3 verifiable-inference stack:
 * the InferenceProvider seam, the verifiability tier taxonomy, and the
 * response-digest reference implementation with cross-language test vectors.
 */
export const AI3_INFERENCE_VERSION = '0.0.1';

export * from './provider.js';
export * from './tiers.js';
export * from './digest.js';
