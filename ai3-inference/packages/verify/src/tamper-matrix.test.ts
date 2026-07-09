/**
 * Tamper matrix (extraction plan T5) — a synthetic enclave (test key + a
 * TDX-quote-shaped fixture) proves the verification chain end-to-end, then
 * every mutation a hostile relay could attempt MUST fail:
 *
 *   flip a response byte / swap the model / alter token counts /
 *   mismatched report_data / attestationRef mismatch / lying tier label.
 *
 * The fixture is byte-layout faithful (report_data at offset 568, RTMR3 at
 * 520) but carries no real Intel signature — the DCAP leg is covered by the
 * T6 verifier fixtures; here it is stubbed pass/fail via the seam.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, hexToBytes, type Hex, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { computeResponseDigest } from '@ai3-inference/core';
import {
  AutoInfAttestationVerifier,
  verifyResponseSignature,
  recoverResponsePublicKey,
  extractReportData,
  extractImageMeasurement,
  UNSAFE_acceptAnyQuote,
  insecureAcceptAnyQuote,
  TDX_REPORT_DATA_OFFSET,
  TDX_RTMR3_OFFSET,
  type ResponseAttestation,
} from './index.js';
import type { ImageTierAllowlist } from './index.js';

// ── synthetic enclave ─────────────────────────────────────────────────────────

const ENCLAVE_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const enclave = privateKeyToAccount(ENCLAVE_KEY);
/** uncompressed pubkey minus the 0x04 prefix — what report_data binds. */
const enclavePubkey = hexToBytes(enclave.publicKey).slice(1);

/** deterministic filler so the fixture is stable across runs. */
function filler(len: number, seed: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = (i * 31 + seed * 7 + 3) & 0xff;
  return out;
}

/** a TDX-v4-shaped quote: header+body up to report_data, report_data = keccak(pubkey) ‖ 0^32. */
function makeQuote(pubkey: Uint8Array, opts: { rtmr3?: Uint8Array } = {}): Uint8Array {
  const quote = filler(TDX_REPORT_DATA_OFFSET + 64, 1);
  const rtmr3 = opts.rtmr3 ?? filler(48, 2);
  quote.set(rtmr3, TDX_RTMR3_OFFSET);
  quote.set(hexToBytes(keccak256(pubkey)), TDX_REPORT_DATA_OFFSET);
  quote.fill(0, TDX_REPORT_DATA_OFFSET + 32, TDX_REPORT_DATA_OFFSET + 64);
  return quote;
}

const QUOTE = makeQuote(enclavePubkey);
const ATTESTATION_REF = keccak256(QUOTE);
const IMAGE_MEASUREMENT = extractImageMeasurement(QUOTE);

const REQUEST_BODY = '{"model":"gpt-5","messages":[{"role":"user","content":"hi"}]}';
const RESPONSE_BODY = '{"choices":[{"message":{"content":"hello"}}],"usage":{"prompt_tokens":7,"completion_tokens":5}}';

const utf8 = (s: string) => new TextEncoder().encode(s);

async function signedAttestation(mutate: Partial<ResponseAttestation> = {}): Promise<ResponseAttestation> {
  const base: ResponseAttestation = {
    requestHash: keccak256(utf8(REQUEST_BODY)),
    responseHash: keccak256(utf8(RESPONSE_BODY)),
    model: 'gpt-5',
    inputTokens: 7,
    outputTokens: 5,
    responseId: 'resp-tamper-1',
    signature: '0x',
  };
  const digest = computeResponseDigest(base);
  const signature = await enclave.signMessage({ message: { raw: digest } });
  // mutations apply AFTER signing — the signature is over the honest fields.
  return { ...base, signature, ...mutate };
}

function verifier(opts: Partial<ConstructorParameters<typeof AutoInfAttestationVerifier>[0]> = {}) {
  return new AutoInfAttestationVerifier({
    attestedSigner: enclave.address as Address,
    attestationRef: ATTESTATION_REF,
    quoteVerifier: UNSAFE_acceptAnyQuote,
    ...opts,
  });
}

// ── baseline: the honest path passes ─────────────────────────────────────────

test('baseline: quote binds, signature verifies, verdict token issued', async () => {
  const att = await signedAttestation();
  const v = verifier();
  const pubkey = await recoverResponsePublicKey(att);
  await v.verifyQuoteOnce(QUOTE, pubkey);
  const res = await v.verifyResponse(att);
  assert.equal(res.verified, true);
  assert.equal(res.token, 'dstack:verified:resp-tamper-1');
});

// ── tamper matrix: every mutation fails ───────────────────────────────────────

test('tamper: flipped response byte → verification fails', async () => {
  const tampered = RESPONSE_BODY.slice(0, 20) + 'X' + RESPONSE_BODY.slice(21);
  const att = await signedAttestation({ responseHash: keccak256(utf8(tampered)) });
  const res = await verifyResponseSignature(att, enclave.address as Address);
  assert.equal(res.verified, false);
  assert.equal(res.token, undefined);
});

test('tamper: swapped model → verification fails', async () => {
  const att = await signedAttestation({ model: 'gpt-5-mini' });
  const res = await verifyResponseSignature(att, enclave.address as Address);
  assert.equal(res.verified, false);
});

test('tamper: altered token counts → verification fails', async () => {
  for (const mutate of [{ inputTokens: 8 }, { outputTokens: 50000 }] as const) {
    const att = await signedAttestation(mutate);
    const res = await verifyResponseSignature(att, enclave.address as Address);
    assert.equal(res.verified, false, `mutation ${JSON.stringify(mutate)} must fail`);
  }
});

test('tamper: garbage signature → verified:false, no throw', async () => {
  const att = await signedAttestation({ signature: ('0x' + 'ab'.repeat(65)) as Hex });
  const res = await verifyResponseSignature(att, enclave.address as Address);
  assert.equal(res.verified, false);
});

test('tamper: report_data binding a different key → verifyQuoteOnce rejects', async () => {
  const otherPubkey = hexToBytes(
    privateKeyToAccount(('0x' + '11'.repeat(32)) as Hex).publicKey,
  ).slice(1);
  const badQuote = makeQuote(otherPubkey);
  // ref matches THIS blob, so the failure isolates the report_data check.
  const v = verifier({ attestationRef: keccak256(badQuote) });
  const att = await signedAttestation();
  const pubkey = await recoverResponsePublicKey(att);
  await assert.rejects(v.verifyQuoteOnce(badQuote, pubkey), /report_data/);
});

test('tamper: quote blob does not hash to attestationRef → verifyQuoteOnce rejects', async () => {
  const flipped = new Uint8Array(QUOTE);
  flipped[0] ^= 0xff;
  const v = verifier();
  const att = await signedAttestation();
  const pubkey = await recoverResponsePublicKey(att);
  await assert.rejects(v.verifyQuoteOnce(flipped, pubkey), /attestationRef/);
});

test('tamper: DCAP verifier says no → verifyQuoteOnce rejects (and retry allowed)', async () => {
  let calls = 0;
  const v = verifier({
    quoteVerifier: async () => {
      calls++;
      return calls > 1; // first call fails, second passes — failure must not be cached
    },
  });
  const att = await signedAttestation();
  const pubkey = await recoverResponsePublicKey(att);
  await assert.rejects(v.verifyQuoteOnce(QUOTE, pubkey), /cryptographic/);
  await v.verifyQuoteOnce(QUOTE, pubkey); // retry succeeds
});

// ── tier-label guard (fusion spec §2.1) inside verifyQuoteOnce ────────────────

const T2_ALLOWLIST: ImageTierAllowlist = {
  version: 999,
  defaultMaxTier: 'dstack-cvm-relay',
  entries: [{ imageHash: IMAGE_MEASUREMENT, maxTier: 'dstack-cvm-inference', note: 'test fixture image' }],
};

test('tier guard: unknown image claiming dstack-cvm-inference → rejects (fail closed to T1)', async () => {
  const v = verifier({ verifiability: 'dstack-cvm-inference' });
  const att = await signedAttestation();
  const pubkey = await recoverResponsePublicKey(att);
  await assert.rejects(v.verifyQuoteOnce(QUOTE, pubkey), /tier/);
});

test('tier guard: unknown image claiming dstack-cvm-relay → passes (T1 ceiling)', async () => {
  const v = verifier({ verifiability: 'dstack-cvm-relay' });
  const att = await signedAttestation();
  const pubkey = await recoverResponsePublicKey(att);
  await v.verifyQuoteOnce(QUOTE, pubkey);
});

test('tier guard: allowlisted image claiming its ceiling → passes', async () => {
  const v = verifier({ verifiability: 'dstack-cvm-inference', allowlist: T2_ALLOWLIST });
  const att = await signedAttestation();
  const pubkey = await recoverResponsePublicKey(att);
  await v.verifyQuoteOnce(QUOTE, pubkey);
});

test('tier guard: allowlisted T2 image claiming fusion → rejects (above ceiling)', async () => {
  const v = verifier({ verifiability: 'dstack-cvm-fusion', allowlist: T2_ALLOWLIST });
  const att = await signedAttestation();
  const pubkey = await recoverResponsePublicKey(att);
  await assert.rejects(v.verifyQuoteOnce(QUOTE, pubkey), /tier/);
});

test('tier guard: free-form label → rejects (closed enum)', async () => {
  const v = verifier({ verifiability: 'super-verified-inference', allowlist: T2_ALLOWLIST });
  const att = await signedAttestation();
  const pubkey = await recoverResponsePublicKey(att);
  await assert.rejects(v.verifyQuoteOnce(QUOTE, pubkey), /tier/);
});

// ── rename (T5): UNSAFE_acceptAnyQuote, deprecated alias retained ─────────────

test('UNSAFE_acceptAnyQuote is the canonical name; insecureAcceptAnyQuote aliases it', async () => {
  assert.equal(typeof UNSAFE_acceptAnyQuote, 'function');
  assert.equal(insecureAcceptAnyQuote, UNSAFE_acceptAnyQuote);
  assert.equal(await UNSAFE_acceptAnyQuote(QUOTE), true);
});

// ── fixture sanity ────────────────────────────────────────────────────────────

test('fixture: report_data extraction matches the layout constant', () => {
  const rd = extractReportData(QUOTE);
  assert.equal(rd.length, 64);
  assert.deepEqual(rd.slice(0, 32), hexToBytes(keccak256(enclavePubkey)));
});
