/**
 * T8 unit tests — the EIP-712 voucher client half must be byte-aligned with
 * InferenceLedger.sol: same typehash string, same domain, same digest. The
 * on-chain half of the gate is contracts/test-hh/voucher-roundtrip.js, which
 * feeds signatures produced by THIS package to the deployed contract.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  keccak256,
  stringToBytes,
  encodeAbiParameters,
  concat,
  hexToBytes,
  recoverAddress,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  VOUCHER_DOMAIN_NAME,
  VOUCHER_DOMAIN_VERSION,
  VOUCHER_TYPEHASH,
  VOUCHER_TYPES,
  voucherDomain,
  hashVoucher,
  signVoucher,
  assertVoucher,
  normalizeSignature,
  isLowS,
  SECP256K1_N,
  SECP256K1_HALF_N,
  nonceWord,
  nonceBit,
  isNonceUsedInWord,
  firstFreeNonceInWord,
  findFreeNonce,
  type Voucher,
} from './index.js';

const USER_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const user = privateKeyToAccount(USER_KEY);

const DOMAIN = { chainId: 8700n, verifyingContract: '0x1111111111111111111111111111111111111111' as Address };
const VOUCHER: Voucher = {
  user: user.address,
  provider: '0x2222222222222222222222222222222222222222' as Address,
  nonce: 259n, // word 1, bit 3 — exercises the bitmap split
  maxFee: 10n ** 15n,
  expiry: 1893456000n, // 2030-01-01
};

// ── byte alignment with InferenceLedger.sol ──────────────────────────────────

test('VOUCHER_TYPEHASH is keccak of the exact solidity literal', () => {
  assert.equal(
    VOUCHER_TYPEHASH,
    keccak256(stringToBytes('Voucher(address user,address provider,uint128 nonce,uint256 maxFee,uint64 expiry)')),
  );
});

test('hashVoucher reproduces the contract digest formula byte-for-byte', () => {
  // manual re-derivation of InferenceLedger.voucherDigest():
  const domainTypehash = keccak256(
    stringToBytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
  );
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [
        domainTypehash,
        keccak256(stringToBytes(VOUCHER_DOMAIN_NAME)),
        keccak256(stringToBytes(VOUCHER_DOMAIN_VERSION)),
        DOMAIN.chainId,
        DOMAIN.verifyingContract,
      ],
    ),
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'uint128' }, { type: 'uint256' }, { type: 'uint64' }],
      [VOUCHER_TYPEHASH, VOUCHER.user, VOUCHER.provider, VOUCHER.nonce, VOUCHER.maxFee, VOUCHER.expiry],
    ),
  );
  const expected = keccak256(concat([new Uint8Array([0x19, 0x01]), hexToBytes(domainSeparator), hexToBytes(structHash)]));
  assert.equal(hashVoucher(VOUCHER, DOMAIN), expected);
});

test('domain name/version match the contract constructor literals', () => {
  assert.equal(VOUCHER_DOMAIN_NAME, 'AIGGInferenceLedger');
  assert.equal(VOUCHER_DOMAIN_VERSION, '1');
  const d = voucherDomain(DOMAIN);
  assert.equal(d.name, 'AIGGInferenceLedger');
  assert.equal(d.version, '1');
  assert.deepEqual(VOUCHER_TYPES.Voucher.map((f) => `${f.type} ${f.name}`), [
    'address user', 'address provider', 'uint128 nonce', 'uint256 maxFee', 'uint64 expiry',
  ]);
});

// ── signing ──────────────────────────────────────────────────────────────────

test('signVoucher: 65 bytes, low-s, v∈{27,28}, recovers to the user', async () => {
  const sig = await signVoucher(user, VOUCHER, DOMAIN);
  const bytes = hexToBytes(sig);
  assert.equal(bytes.length, 65);
  assert.ok(isLowS(sig), 'signature must be low-s (contract rejects high-s)');
  assert.ok(bytes[64] === 27 || bytes[64] === 28, `v is ${bytes[64]}`);
  const recovered = await recoverAddress({ hash: hashVoucher(VOUCHER, DOMAIN), signature: sig });
  assert.equal(recovered.toLowerCase(), VOUCHER.user.toLowerCase());
});

test('assertVoucher rejects out-of-range fields', () => {
  assertVoucher(VOUCHER); // baseline ok
  assert.throws(() => assertVoucher({ ...VOUCHER, nonce: 1n << 128n }), /nonce/);
  assert.throws(() => assertVoucher({ ...VOUCHER, nonce: -1n }), /nonce/);
  assert.throws(() => assertVoucher({ ...VOUCHER, expiry: 1n << 64n }), /expiry/);
  assert.throws(() => assertVoucher({ ...VOUCHER, maxFee: -1n }), /maxFee/);
});

// ── high-s normalization ─────────────────────────────────────────────────────

test('normalizeSignature: a malleated high-s signature is restored to low-s and still recovers', async () => {
  const sig = await signVoucher(user, VOUCHER, DOMAIN);
  const bytes = hexToBytes(sig);
  const s = BigInt('0x' + Buffer.from(bytes.slice(32, 64)).toString('hex'));
  // malleate: s' = N - s, v flipped — same math the contract rejects.
  const sHigh = SECP256K1_N - s;
  assert.ok(sHigh > SECP256K1_HALF_N);
  const high = new Uint8Array(bytes);
  high.set(hexToBytes(`0x${sHigh.toString(16).padStart(64, '0')}`), 32);
  high[64] = bytes[64] === 27 ? 28 : 27;
  const highHex = `0x${Buffer.from(high).toString('hex')}` as Hex;
  assert.ok(!isLowS(highHex));

  const normalized = normalizeSignature(highHex);
  assert.equal(normalized, sig, 'normalization must restore the canonical signature');
  assert.ok(isLowS(normalized));
  const recovered = await recoverAddress({ hash: hashVoucher(VOUCHER, DOMAIN), signature: normalized });
  assert.equal(recovered.toLowerCase(), VOUCHER.user.toLowerCase());
});

test('normalizeSignature is a no-op on canonical signatures and rejects malformed input', async () => {
  const sig = await signVoucher(user, VOUCHER, DOMAIN);
  assert.equal(normalizeSignature(sig), sig);
  assert.throws(() => normalizeSignature('0x1234' as Hex), /65/);
});

// ── nonce bitmap helpers (contract: word = nonce >> 8, bit = 1 << (nonce & 0xff)) ──

test('nonce word/bit math matches the contract layout', () => {
  assert.equal(nonceWord(0n), 0n);
  assert.equal(nonceBit(0n), 1n);
  assert.equal(nonceWord(255n), 0n);
  assert.equal(nonceBit(255n), 1n << 255n);
  assert.equal(nonceWord(256n), 1n);
  assert.equal(nonceBit(256n), 1n);
  assert.equal(nonceWord(259n), 1n);
  assert.equal(nonceBit(259n), 8n);
});

test('isNonceUsedInWord / firstFreeNonceInWord', () => {
  const bits = (1n << 0n) | (1n << 3n); // nonces 0 and 3 of word 0 used
  assert.equal(isNonceUsedInWord(bits, 0n), true);
  assert.equal(isNonceUsedInWord(bits, 1n), false);
  assert.equal(isNonceUsedInWord(bits, 3n), true);
  assert.equal(firstFreeNonceInWord(bits, 0n), 1n);
  assert.equal(firstFreeNonceInWord(0n, 5n), 5n * 256n);
  const full = (1n << 256n) - 1n;
  assert.equal(firstFreeNonceInWord(full, 0n), null);
});

test('findFreeNonce scans words via the injected reader', async () => {
  const words = new Map<bigint, bigint>([
    [0n, (1n << 256n) - 1n], // word 0 exhausted
    [1n, (1n << 0n) | (1n << 1n)], // 256,257 used → 258 free
  ]);
  const nonce = await findFreeNonce(async (w) => words.get(w) ?? 0n);
  assert.equal(nonce, 258n);
  // fresh ledger → nonce 0
  assert.equal(await findFreeNonce(async () => 0n), 0n);
});
