/**
 * @ai3-inference/verify — isomorphic verification (node CLI + browser).
 *
 * Scaffold (extraction plan T1). T5/T6 move the attestation module here
 * (verifyResponseSignature, verifyQuoteOnce, the QuoteVerifier seam and a
 * real DCAP integration) plus the imageHash→tier allowlist data, and later
 * verifyFusionReceipt (fusion spec §10). Browser-safe: no node-only APIs.
 */
export const AI3_VERIFY_VERSION = '0.0.1';
