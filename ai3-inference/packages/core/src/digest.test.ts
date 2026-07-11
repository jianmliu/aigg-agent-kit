/**
 * Vector test — asserts the digest reference implementation against the shared
 * cross-language fixture. The same fixture (byte-identical copy) is asserted
 * by the Go signer's test in aigg-src backend/internal/service/attest/, so a
 * silent divergence between the two languages fails one side's CI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeResponseDigest, eip191DigestHash } from './digest.js';
import type { Hex } from 'viem';

interface Vector {
  name: string;
  requestHash: Hex;
  responseHash: Hex;
  model: string;
  inputTokens: string;
  outputTokens: string;
  digest: Hex;
  eip191: Hex;
}

const fixturePath = fileURLToPath(new URL('../vectors/digest-vectors.json', import.meta.url));
const { vectors } = JSON.parse(readFileSync(fixturePath, 'utf8')) as { vectors: Vector[] };

test('fixture is non-trivial', () => {
  assert.ok(vectors.length >= 6);
});

for (const v of vectors) {
  test(`vector: ${v.name}`, () => {
    const digest = computeResponseDigest({
      requestHash: v.requestHash,
      responseHash: v.responseHash,
      model: v.model,
      inputTokens: BigInt(v.inputTokens),
      outputTokens: BigInt(v.outputTokens),
    });
    assert.equal(digest, v.digest);
    assert.equal(eip191DigestHash(digest), v.eip191);
  });
}

test('digest is sensitive to every field', () => {
  const base = vectors[0]!;
  const fields = {
    requestHash: base.requestHash,
    responseHash: base.responseHash,
    model: base.model,
    inputTokens: BigInt(base.inputTokens),
    outputTokens: BigInt(base.outputTokens),
  };
  const flippedHash = (h: Hex): Hex =>
    (h.slice(0, 3) + (h[3] === '0' ? '1' : '0') + h.slice(4)) as Hex;
  const mutations: Array<Partial<typeof fields>> = [
    { requestHash: flippedHash(base.requestHash) },
    { responseHash: flippedHash(base.responseHash) },
    { model: base.model + 'x' },
    { inputTokens: BigInt(base.inputTokens) + 1n },
    { outputTokens: BigInt(base.outputTokens) + 1n },
  ];
  for (const m of mutations) {
    assert.notEqual(computeResponseDigest({ ...fields, ...m }), base.digest);
  }
});

test('rejects out-of-range and malformed input', () => {
  const base = vectors[0]!;
  const fields = {
    requestHash: base.requestHash,
    responseHash: base.responseHash,
    model: base.model,
    inputTokens: 1n,
    outputTokens: 1n,
  };
  assert.throws(() => computeResponseDigest({ ...fields, inputTokens: -1n }), RangeError);
  assert.throws(() => computeResponseDigest({ ...fields, outputTokens: 1n << 64n }), RangeError);
  assert.throws(() => computeResponseDigest({ ...fields, requestHash: '0x1234' }), RangeError);
  assert.throws(() => eip191DigestHash('0xabcd'), RangeError);
});
