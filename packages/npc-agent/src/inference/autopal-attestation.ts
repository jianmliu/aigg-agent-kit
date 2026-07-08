/**
 * MOVED (extraction plan T4) → @ai3-inference/verify.
 *
 * Canonical home: ai3-inference/packages/verify/src/autopal-attestation.ts.
 * This shim keeps every existing import path and the @aigg/npc-agent public
 * API working; new code should import from '@ai3-inference/verify' directly.
 */
export {
  AutopalAttestationVerifier,
  computeResponseDigest,
  verifyResponseSignature,
  recoverResponsePublicKey,
  extractReportData,
  parseAttestationHeaders,
  insecureAcceptAnyQuote,
  ATTEST_HEADERS,
  TDX_REPORT_DATA_OFFSET,
} from '@ai3-inference/verify';
export type {
  ResponseDigestFields,
  ResponseAttestation,
  VerifyResponseResult,
  QuoteVerifier,
  AutopalVerifierOptions,
  HeaderLike,
} from '@ai3-inference/verify';
