/**
 * imageHash→tier allowlist (fusion spec §2.1, extraction plan T5) — the
 * versioned data file + lookup semantics. The invariant under test: an image
 * hash NOT on the allowlist is capped at T1 (`dstack-cvm-relay`), i.e. the
 * map fails CLOSED — a lying `verifiability` label can never grant a tier the
 * image was not granted by the shipped data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IMAGE_TIER_ALLOWLIST,
  IMAGE_TIER_ALLOWLIST_VERSION,
  maxTierForImage,
  assertTierAllowedForImage,
  type ImageTierAllowlist,
} from './index.js';

const SAMPLE: ImageTierAllowlist = {
  version: 42,
  defaultMaxTier: 'dstack-cvm-relay',
  entries: [
    { imageHash: '0x' + 'aa'.repeat(48), maxTier: 'dstack-cvm-inference', note: 'vllm compose' },
    { imageHash: 'bb'.repeat(48), maxTier: 'dstack-cvm-fusion', note: 'orchestrator compose' },
  ],
};

test('shipped data file: versioned, fails closed to T1', () => {
  assert.equal(typeof IMAGE_TIER_ALLOWLIST.version, 'number');
  assert.equal(IMAGE_TIER_ALLOWLIST.version, IMAGE_TIER_ALLOWLIST_VERSION);
  assert.equal(IMAGE_TIER_ALLOWLIST.defaultMaxTier, 'dstack-cvm-relay');
  for (const e of IMAGE_TIER_ALLOWLIST.entries) {
    assert.match(e.imageHash.replace(/^0x/, ''), /^[0-9a-f]+$/, 'entries are lowercase hex');
  }
});

test('unknown image → default ceiling T1', () => {
  assert.equal(maxTierForImage('0x' + 'cc'.repeat(48), SAMPLE), 'dstack-cvm-relay');
  assert.equal(maxTierForImage('0x' + 'cc'.repeat(48)), 'dstack-cvm-relay'); // shipped data too
});

test('lookup is 0x- and case-insensitive', () => {
  assert.equal(maxTierForImage('AA'.repeat(48), SAMPLE), 'dstack-cvm-inference');
  assert.equal(maxTierForImage('0x' + 'BB'.repeat(48), SAMPLE), 'dstack-cvm-fusion');
});

test('assertTierAllowedForImage: within ceiling passes, above throws', () => {
  // T2 image: relay + inference OK, fusion throws.
  assertTierAllowedForImage('dstack-cvm-relay', '0x' + 'aa'.repeat(48), SAMPLE);
  assertTierAllowedForImage('dstack-cvm-inference', '0x' + 'aa'.repeat(48), SAMPLE);
  assert.throws(() => assertTierAllowedForImage('dstack-cvm-fusion', '0x' + 'aa'.repeat(48), SAMPLE), /tier/);
  // unknown image: only T0/T1 claims survive.
  assertTierAllowedForImage('dstack-cvm-relay', '0x' + 'ee'.repeat(48), SAMPLE);
  assert.throws(() => assertTierAllowedForImage('dstack-cvm-inference', '0x' + 'ee'.repeat(48), SAMPLE), /tier/);
});

test('unknown/free-form label always throws (closed enum)', () => {
  assert.throws(() => assertTierAllowedForImage('tee-verified-inference', '0x' + 'aa'.repeat(48), SAMPLE), /tier/);
  assert.throws(() => assertTierAllowedForImage('', '0x' + 'aa'.repeat(48), SAMPLE), /tier/);
});
