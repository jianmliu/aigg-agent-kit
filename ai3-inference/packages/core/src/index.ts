/**
 * @ai3-inference/core — shared types for the AI3 verifiable-inference stack.
 *
 * Scaffold (extraction plan T1). T3 fills this package with:
 *   - InferenceProvider / Attestation / usage types (copied from
 *     aigg-agent-kit packages/npc-agent/src/inference/provider.ts; the kit
 *     will re-export from here),
 *   - the verifiability tier enum (T0 scripted / T1 dstack-cvm-relay /
 *     T2 dstack-cvm-inference / T3 dstack-cvm-fusion),
 *   - the digest reference implementation
 *     keccak(reqHash ‖ respHash ‖ model ‖ inTok ‖ outTok) with
 *     cross-language test vectors shared with the Go signer.
 */
export const AI3_INFERENCE_VERSION = '0.0.1';
