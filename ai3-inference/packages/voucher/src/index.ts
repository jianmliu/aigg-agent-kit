/**
 * @ai3-inference/voucher — EIP-712 voucher client half (Phase B).
 *
 * Scaffold (extraction plan T1). T8 implements the typed-data domain
 * (AIGGInferenceLedger v1) and Voucher struct byte-aligned with
 * contracts/src/market/InferenceLedger.sol —
 * Voucher(address user,address provider,uint128 nonce,uint256 maxFee,
 * uint64 expiry) — plus nonce-bitmap helpers and high-s normalization.
 * Round-trip verified against the hardhat specs.
 */
export const AI3_VOUCHER_VERSION = '0.0.1';
