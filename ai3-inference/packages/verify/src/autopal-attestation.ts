/**
 * AutoPal attestation verification — the CLIENT side of the Auto EVM provider
 * market's Phase A (spec 2026-07-05-autoevm-provider-market-design.md §3.3, §6, §9).
 *
 * The gateway (a dstack CVM) publishes to the on-chain ServiceRegistry:
 *   • attestedSigner — the enclave response-signing address;
 *   • attestationRef — keccak256 of the dstack TDX quote blob (blob on DSN).
 * Every relayed response is signed by that enclave key over
 *   keccak256(reqHash ‖ respHash ‖ model ‖ inTok ‖ outTok)   (EIP-191).
 *
 * This module implements the two verification steps a client runs — mirroring
 * 0G's design (verify the quote ONCE, then cheap ECDSA per response):
 *
 *   1. verifyQuoteOnce — fetch the quote blob from DSN by attestationRef, check
 *      keccak256(blob) === attestationRef, check the quote's report_data binds
 *      the signer's pubkey (keccak256(pubkey)), and run the injected TDX quote
 *      verifier (DCAP). Cached per signer+ref.
 *   2. verifyResponse — recompute the digest, ECDSA-recover the signer from the
 *      response signature, compare to attestedSigner. Returns the honest verdict
 *      token `dstack:verified:<responseId>` — NEVER fabricated.
 *
 * Honest boundary (spec §7): a passing verdict means the response came, untampered,
 * from the attested sealed-relay enclave — NOT that the upstream vendor ran the
 * claimed weights. Surface it as "TEE-verified relay", never "…inference".
 *
 * Crypto via viem (keccak256 / secp256k1 recover). Pure functions are exported so
 * a full AutoPalBrokerProvider (Phase C) reuses them.
 */
import {
  keccak256,
  hexToBytes,
  bytesToHex,
  getAddress,
  isAddressEqual,
  recoverMessageAddress,
  recoverPublicKey,
  hashMessage,
  type Hex,
  type Address,
} from 'viem';
import { computeResponseDigest, type ResponseDigestFields } from '@ai3-inference/core';

// The digest reference implementation (and its cross-language vectors) lives in
// @ai3-inference/core; re-exported here so existing consumers keep their import.
export { computeResponseDigest, type ResponseDigestFields };

/** Attestation fields carried on a response (headers/trailers X-AIGG-Attest-*). */
export interface ResponseAttestation extends ResponseDigestFields {
  responseId: string;
  signature: Hex; // 65-byte EIP-191 sig, V in {27,28}
}

export interface VerifyResponseResult {
  /** true iff the signature recovers to the expected attestedSigner. */
  verified: boolean;
  /** the address the signature actually recovered to (for diagnostics). */
  recovered: Address;
  /** honest verdict token, present ONLY when verified. */
  token?: string;
}

/**
 * verifyResponseSignature — recompute the digest and ECDSA-recover the signer,
 * comparing to expectedSigner. The workhorse, called per response. Never throws
 * on a bad signature; returns verified:false.
 */
export async function verifyResponseSignature(
  att: ResponseAttestation,
  expectedSigner: Address,
): Promise<VerifyResponseResult> {
  const digest = computeResponseDigest(att);
  let recovered: Address;
  try {
    recovered = await recoverMessageAddress({ message: { raw: digest }, signature: att.signature });
  } catch {
    return { verified: false, recovered: '0x0000000000000000000000000000000000000000' };
  }
  const verified = isAddressEqual(recovered, expectedSigner);
  return {
    verified,
    recovered,
    ...(verified ? { token: `dstack:verified:${att.responseId}` } : {}),
  };
}

/**
 * recoverResponsePublicKey — the uncompressed 64-byte pubkey (X‖Y, no 0x04) the
 * response signature recovers to. Needed to bind the enclave key to the quote's
 * report_data. Throws on a malformed signature.
 */
export async function recoverResponsePublicKey(att: ResponseAttestation): Promise<Uint8Array> {
  const digest = computeResponseDigest(att);
  const hash = hashMessage({ raw: digest });
  const pub = await recoverPublicKey({ hash, signature: att.signature }); // 0x04‖X‖Y
  const bytes = hexToBytes(pub);
  if (bytes.length !== 65 || bytes[0] !== 0x04) {
    throw new Error('[autopal-attest] unexpected recovered pubkey length');
  }
  return bytes.slice(1); // 64 bytes
}

/** Standard Intel TDX v4 quote: report_data is 64 bytes at this offset
 *  (header 48 + TD report body 584, report_data = last 64 of the body). */
export const TDX_REPORT_DATA_OFFSET = 568;

/**
 * extractReportData — the 64-byte report_data field from a raw TDX quote. dstack
 * zero-pads a shorter caller value to 64; the gateway sets it to
 * keccak256(pubkey) (32 bytes) ‖ zeros(32). Offset overridable for non-standard
 * quote layouts.
 */
export function extractReportData(quote: Uint8Array, offset: number = TDX_REPORT_DATA_OFFSET): Uint8Array {
  if (quote.length < offset + 64) {
    throw new Error(`[autopal-attest] quote too short for report_data at offset ${offset} (len ${quote.length})`);
  }
  return quote.slice(offset, offset + 64);
}

/**
 * QuoteVerifier — the injected TDX/DCAP cryptographic check (Intel cert chain +
 * measurement policy). Deliberately a seam: on-chain quote verification is
 * prohibitively expensive and a DCAP library choice is deployment-specific
 * (spec §3.3, §10). Return true iff the quote is a valid TDX quote from an
 * acceptable measurement. A production client MUST provide a real one.
 */
export type QuoteVerifier = (quote: Uint8Array) => Promise<boolean>;

/**
 * insecureAcceptAnyQuote — a QuoteVerifier that skips the hardware check. For
 * tests / bring-up ONLY. Using it in production reduces the guarantee to "some
 * key signed consistently", with NO hardware root — never ship with this.
 */
export const insecureAcceptAnyQuote: QuoteVerifier = async () => true;

export interface AutopalVerifierOptions {
  attestedSigner: Address;       // ServiceRegistry Service.attestedSigner
  attestationRef: Hex;           // ServiceRegistry Service.attestationRef (keccak of quote)
  /** verifies the TDX quote cryptographically; REQUIRED for a real guarantee. */
  quoteVerifier: QuoteVerifier;
  /** report_data offset override for non-standard quote layouts. */
  reportDataOffset?: number;
}

/**
 * AutopalAttestationVerifier — holds a provider's registry attestation and
 * verifies its responses. verifyQuoteOnce is cached; verifyResponse is per-call.
 */
export class AutopalAttestationVerifier {
  readonly attestedSigner: Address;
  readonly attestationRef: Hex;
  private readonly quoteVerifier: QuoteVerifier;
  private readonly reportDataOffset: number;
  private quoteVerified: Promise<void> | null = null;

  constructor(opts: AutopalVerifierOptions) {
    this.attestedSigner = getAddress(opts.attestedSigner);
    this.attestationRef = opts.attestationRef.toLowerCase() as Hex;
    this.quoteVerifier = opts.quoteVerifier;
    this.reportDataOffset = opts.reportDataOffset ?? TDX_REPORT_DATA_OFFSET;
  }

  /**
   * verifyQuoteOnce — run the one-time quote checks against a blob fetched from
   * DSN and a pubkey recovered from any verified response. Idempotent: the first
   * successful call is cached; later calls return the cached result. A failure
   * is NOT cached (so a transient DSN error can be retried).
   *
   * Checks, in order:
   *   1. keccak256(quoteBlob) === attestationRef   (registry ref integrity)
   *   2. report_data(quote)[:32] === keccak256(pubkey)  (quote binds this signer)
   *   3. quoteVerifier(quoteBlob)                   (TDX hardware validity)
   */
  async verifyQuoteOnce(quoteBlob: Uint8Array, signerPubkey: Uint8Array): Promise<void> {
    if (this.quoteVerified) return this.quoteVerified;
    const run = (async () => {
      const blobRef = keccak256(quoteBlob).toLowerCase();
      if (blobRef !== this.attestationRef) {
        throw new Error(`[autopal-attest] quote blob ref ${blobRef} != registered attestationRef ${this.attestationRef}`);
      }
      const reportData = extractReportData(quoteBlob, this.reportDataOffset);
      const expect = hexToBytes(keccak256(signerPubkey)); // 32 bytes
      const bound = reportData.slice(0, 32);
      if (bytesToHex(bound) !== bytesToHex(expect)) {
        throw new Error('[autopal-attest] quote report_data does not bind the response signer pubkey');
      }
      const ok = await this.quoteVerifier(quoteBlob);
      if (!ok) throw new Error('[autopal-attest] TDX quote failed cryptographic verification');
    })();
    this.quoteVerified = run;
    try {
      await run;
    } catch (e) {
      this.quoteVerified = null; // allow retry
      throw e;
    }
  }

  /** verifyResponse — per-response ECDSA against attestedSigner. */
  verifyResponse(att: ResponseAttestation): Promise<VerifyResponseResult> {
    return verifyResponseSignature(att, this.attestedSigner);
  }
}

/** header/trailer names the gateway emits (attest.Header* on the Go side). */
export const ATTEST_HEADERS = {
  signer: 'x-aigg-attest-signer',
  signature: 'x-aigg-attest-sig',
  responseId: 'x-aigg-attest-response-id',
  payloadHash: 'x-aigg-attest-payload-hash',
  verification: 'x-aigg-attest-verification',
  model: 'x-aigg-attest-model',
  inputTokens: 'x-aigg-attest-input-tokens',
  outputTokens: 'x-aigg-attest-output-tokens',
} as const;

/** a minimal headers-like accessor (Headers, or a plain lowercased map). */
export interface HeaderLike {
  get(name: string): string | null;
}

/**
 * parseAttestationHeaders — assemble a ResponseAttestation from a response's
 * headers/trailers plus the two hashes the client computes ITSELF from the exact
 * request and response bytes it sent/received. Binding both means verification
 * detects any tampering with either side; that is why the client must supply
 * them rather than trust the gateway's advisory payload-hash header.
 *
 * Returns null when the signature or response id is absent (attestation disabled
 * on that endpoint).
 *
 * Transport note: the gateway delivers the signature as an HTTP trailer for
 * streamed responses. Standard fetch does not expose trailers, so a streaming
 * client reads them from a trailing SSE event instead; this parser is agnostic
 * — pass whatever HeaderLike carries the values.
 */
export function parseAttestationHeaders(
  h: HeaderLike,
  requestHash: Hex,
  responseHash: Hex,
): ResponseAttestation | null {
  const signature = h.get(ATTEST_HEADERS.signature) as Hex | null;
  const responseId = h.get(ATTEST_HEADERS.responseId);
  if (!signature || !responseId) return null;
  return {
    requestHash,
    responseHash,
    model: h.get(ATTEST_HEADERS.model) ?? '',
    inputTokens: Number(h.get(ATTEST_HEADERS.inputTokens) ?? '0'),
    outputTokens: Number(h.get(ATTEST_HEADERS.outputTokens) ?? '0'),
    responseId,
    signature,
  };
}
