/**
 * autoinf-attestation smoke — the CLIENT verify path against a REAL vector
 * produced by the Go gateway signer (aigg-src attest.ResponseSigner), proving
 * byte-for-byte cross-language parity of the digest + EIP-191 signature scheme.
 *
 * Vector source (seed = bytes[1..32], reqHash = 0xa0.., respHash = 0xb0..,
 * model "claude-opus-4-8", tokens 1234/567):
 *   go test ./internal/service/attest -run TestPrintVector
 *
 * Run: tsx src/__tests__/autoinf-attestation.smoke.ts
 */
import assert from 'node:assert/strict';
import { keccak256, bytesToHex, type Hex, type Address } from 'viem';
import {
  computeResponseDigest,
  verifyResponseSignature,
  recoverResponsePublicKey,
  extractReportData,
  AutoInfAttestationVerifier,
  insecureAcceptAnyQuote,
  parseAttestationHeaders,
  ATTEST_HEADERS,
  TDX_REPORT_DATA_OFFSET,
  type ResponseAttestation,
} from '../index';

// ── the Go-produced vector ───────────────────────────────────────────────────
const V = {
  signer: '0x6f719906F7Dd6710D91e02fFEaafAC6916e43d7d' as Address,
  requestHash: '0xa0a1a2a3a4a5a6a7a8a9aaabacadaeafa0a1a2a3a4a5a6a7a8a9aaabacadaeaf' as Hex,
  responseHash: '0xb0b1b2b3b4b5b6b7b8b9babbbcbdbebfb0b1b2b3b4b5b6b7b8b9babbbcbdbebf' as Hex,
  payloadHash: '0x36c61b6d65acb554169840ac9d670b8c7f60c06f8675d9333e7621fd82320f0d' as Hex,
  signature:
    '0x6fc3bec01d34a1f7b1e9cf1e2f22c3d2efdda207db22d3fd68d8f342daeedc5e2130550182cdc782f5312a242cba7e2d5170c18751035a7d3805319ac7b75a201c' as Hex,
  pubkey:
    '0xab9b938460a95bcbcf7cf39501cd33d4afeb5ec6d09a20998d71e83cf8989136550330e987ca5b9de442721555d9c0bd49907a6a5528b86da8de280fd2b4efa3' as Hex,
  reportData: '0x80df54f18b06e5b071855c896f719906f7dd6710d91e02ffeaafac6916e43d7d' as Hex,
  responseId: 'resp_vec1',
  model: 'claude-opus-4-8',
  inputTokens: 1234,
  outputTokens: 567,
};

const att: ResponseAttestation = {
  requestHash: V.requestHash,
  responseHash: V.responseHash,
  model: V.model,
  inputTokens: V.inputTokens,
  outputTokens: V.outputTokens,
  responseId: V.responseId,
  signature: V.signature,
};

async function main() {
  // 1. digest parity — TS keccak == Go PayloadDigest.
  const digest = computeResponseDigest(att);
  assert.equal(digest, V.payloadHash, 'digest must match the Go signer byte-for-byte');

  // 2. per-response ECDSA recovers to the attestedSigner.
  const ok = await verifyResponseSignature(att, V.signer);
  assert.equal(ok.verified, true, 'signature must verify against attestedSigner');
  assert.equal(ok.token, `dstack:verified:${V.responseId}`, 'honest verdict token');
  assert.equal(ok.recovered.toLowerCase(), V.signer.toLowerCase(), 'recovered == signer');

  // 3. tamper detection — any field flip breaks verification.
  for (const mut of [
    { ...att, model: 'gpt-5' },
    { ...att, inputTokens: att.inputTokens + 1 },
    { ...att, responseHash: ('0x' + 'cc'.repeat(32)) as Hex },
  ]) {
    const bad = await verifyResponseSignature(mut, V.signer);
    assert.equal(bad.verified, false, 'tampered field must fail');
    assert.equal(bad.token, undefined, 'no token on failure');
  }

  // 4. wrong expected signer fails.
  const wrong = await verifyResponseSignature(att, '0x0000000000000000000000000000000000000001');
  assert.equal(wrong.verified, false, 'wrong signer must fail');

  // 5. pubkey recovery matches the Go pubkey, and keccak(pubkey) == report_data.
  const pub = await recoverResponsePublicKey(att);
  assert.equal(bytesToHex(pub), V.pubkey, 'recovered pubkey matches Go');
  assert.equal(keccak256(pub), V.reportData, 'keccak256(pubkey) == report_data');

  // 6. quote-binding: synth a TDX-shaped blob whose report_data region carries
  //    keccak256(pubkey)‖zeros, register its keccak as attestationRef, verify once.
  const reportData32 = keccak256(pub); // 0x..32
  const quote = new Uint8Array(TDX_REPORT_DATA_OFFSET + 64);
  for (let i = 0; i < TDX_REPORT_DATA_OFFSET; i++) quote[i] = (i * 7) & 0xff; // arbitrary header/body
  quote.set(hexToU8(reportData32), TDX_REPORT_DATA_OFFSET); // report_data[:32]
  // report_data[32:64] stays zero (dstack pad)
  const attestationRef = keccak256(quote);

  // extractReportData returns the 64-byte field; first 32 bind the signer.
  const rd = extractReportData(quote);
  assert.equal(bytesToHex(rd.slice(0, 32)), reportData32, 'extracted report_data binds pubkey');

  const verifier = new AutoInfAttestationVerifier({
    attestedSigner: V.signer,
    attestationRef,
    quoteVerifier: insecureAcceptAnyQuote,
  });
  await verifier.verifyQuoteOnce(quote, pub); // must not throw
  // cached second call is a no-op
  await verifier.verifyQuoteOnce(quote, pub);
  const via = await verifier.verifyResponse(att);
  assert.equal(via.verified, true, 'verifier.verifyResponse ok');

  // 7. quote-binding failures: wrong ref, wrong pubkey, failing DCAP.
  await assertRejects(() =>
    new AutoInfAttestationVerifier({
      attestedSigner: V.signer,
      attestationRef: ('0x' + '11'.repeat(32)) as Hex,
      quoteVerifier: insecureAcceptAnyQuote,
    }).verifyQuoteOnce(quote, pub),
    'wrong attestationRef',
  );
  await assertRejects(() =>
    new AutoInfAttestationVerifier({
      attestedSigner: V.signer,
      attestationRef,
      quoteVerifier: insecureAcceptAnyQuote,
    }).verifyQuoteOnce(quote, new Uint8Array(64) /* wrong pubkey */),
    'pubkey not bound by report_data',
  );
  await assertRejects(() =>
    new AutoInfAttestationVerifier({
      attestedSigner: V.signer,
      attestationRef,
      quoteVerifier: async () => false, // DCAP rejects
    }).verifyQuoteOnce(quote, pub),
    'TDX verifier rejects',
  );

  // 8. header parsing round-trip (client supplies its own two hashes).
  const headers = new Map<string, string>([
    [ATTEST_HEADERS.signature, V.signature],
    [ATTEST_HEADERS.responseId, V.responseId],
    [ATTEST_HEADERS.model, V.model],
    [ATTEST_HEADERS.inputTokens, String(V.inputTokens)],
    [ATTEST_HEADERS.outputTokens, String(V.outputTokens)],
  ]);
  const hl = { get: (n: string) => headers.get(n) ?? null };
  const parsed = parseAttestationHeaders(hl, V.requestHash, V.responseHash);
  assert.ok(parsed, 'parsed attestation present');
  const fromHeaders = await verifyResponseSignature(parsed!, V.signer);
  assert.equal(fromHeaders.verified, true, 'attestation assembled from headers verifies');

  // 9. absent signature → null (attestation disabled).
  const none = parseAttestationHeaders({ get: () => null }, V.requestHash, V.responseHash);
  assert.equal(none, null, 'no signature header → null');

  console.log('autoinf-attestation smoke: OK (9 groups, real Go vector parity)');
}

function hexToU8(h: Hex): Uint8Array {
  const s = h.slice(2);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function assertRejects(fn: () => Promise<unknown>, label: string) {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  assert.equal(threw, true, `expected rejection: ${label}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
