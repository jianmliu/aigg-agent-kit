/**
 * @ai3-inference/voucher — EIP-712 voucher client half (extraction plan T8,
 * Phase B). Byte-aligned with contracts/src/market/InferenceLedger.sol:
 * typed-data domain AIGGInferenceLedger v1, Voucher(address user,address
 * provider,uint128 nonce,uint256 maxFee,uint64 expiry), nonce-bitmap
 * helpers, high-s normalization. Round-trip verified against the hardhat
 * specs (contracts/test-hh/voucher-roundtrip.js consumes this package's
 * built output). Isomorphic: viem only.
 */
export const AI3_VOUCHER_VERSION = '0.0.1';

export * from './voucher.js';
export * from './signature.js';
export * from './nonce.js';
