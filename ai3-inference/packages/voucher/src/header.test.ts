/** T9 — voucher header wire protocol round-trip + validation. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Address } from 'viem';
import { encodeVoucher, decodeVoucher, VOUCHER_HEADERS, type Voucher } from './index.js';

const V: Voucher = {
  user: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address,
  provider: '0x2222222222222222222222222222222222222222' as Address,
  nonce: 259n,
  maxFee: 10n ** 16n,
  expiry: 1893456000n,
};

test('header names are the spec §4.1 pair', () => {
  assert.equal(VOUCHER_HEADERS.voucher, 'x-aigg-voucher');
  assert.equal(VOUCHER_HEADERS.signature, 'x-aigg-voucher-sig');
});

test('encode → decode round-trips exactly', () => {
  const encoded = encodeVoucher(V);
  assert.match(encoded, /^[\x20-\x7e]+$/, 'header value must be printable ASCII');
  assert.ok(!encoded.includes('\n'));
  assert.deepEqual(decodeVoucher(encoded), V);
});

test('encoding is canonical: fixed field order, decimal bigints', () => {
  assert.equal(
    encodeVoucher(V),
    '{"user":"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266","provider":"0x2222222222222222222222222222222222222222","nonce":"259","maxFee":"10000000000000000","expiry":"1893456000"}',
  );
});

test('decode rejects malformed input', () => {
  assert.throws(() => decodeVoucher('not json'), /JSON/);
  assert.throws(() => decodeVoucher(JSON.stringify({ ...JSON.parse(encodeVoucher(V)), nonce: '0x10' })), /nonce/);
  assert.throws(() => decodeVoucher(JSON.stringify({ ...JSON.parse(encodeVoucher(V)), maxFee: 5 })), /maxFee/);
  assert.throws(() => decodeVoucher(JSON.stringify({ ...JSON.parse(encodeVoucher(V)), user: 'nobody' })));
  // out-of-range fields fail the shared assertVoucher
  assert.throws(() => decodeVoucher(JSON.stringify({ ...JSON.parse(encodeVoucher(V)), expiry: (1n << 65n).toString() })), /expiry/);
});
