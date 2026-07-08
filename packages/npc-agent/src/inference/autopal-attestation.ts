/**
 * MOVED (extraction plan T4) → @ai3-inference/verify, and RENAMED
 * autopal → autoinf (2026-07-08). Canonical home:
 * ai3-inference/packages/verify/src/autoinf-attestation.ts.
 *
 * This shim keeps every existing import path working and keeps the OLD
 * Autopal* names as deprecated aliases; new code imports the AutoInf* names
 * from '@ai3-inference/verify' directly.
 */
export {
  AutoInfAttestationVerifier,
  computeResponseDigest,
  verifyResponseSignature,
  recoverResponsePublicKey,
  extractReportData,
  parseAttestationHeaders,
  insecureAcceptAnyQuote,
  ATTEST_HEADERS,
  TDX_REPORT_DATA_OFFSET,
  // deprecated alias (pre-rename API)
  AutoInfAttestationVerifier as AutopalAttestationVerifier,
} from '@ai3-inference/verify';
export type {
  ResponseDigestFields,
  ResponseAttestation,
  VerifyResponseResult,
  QuoteVerifier,
  AutoInfVerifierOptions,
  HeaderLike,
  // deprecated alias (pre-rename API)
  AutoInfVerifierOptions as AutopalVerifierOptions,
} from '@ai3-inference/verify';
