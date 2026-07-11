/**
 * EIP-712 voucher build/sign (extraction plan T8) — the client half of
 * InferenceLedger.sol's settlement coupling, byte-aligned with the contract:
 *
 *   Voucher(address user,address provider,uint128 nonce,uint256 maxFee,uint64 expiry)
 *   domain: name "AIGGInferenceLedger", version "1", chainId, verifyingContract
 *
 * A signed voucher is the user's authorization for ONE request costing at
 * most `maxFee` wei-of-AI3; the provider batch-settles them on-chain. The
 * contract rejects malleable high-s signatures and v ∉ {27,28}, so
 * signVoucher always emits the canonical form (see ./signature.ts).
 *
 * Isomorphic: viem only, no node APIs — the same module signs in a browser
 * wallet flow and in the conformance CLI.
 */
import { hashTypedData, keccak256, stringToBytes, type Address, type Hex, type TypedDataDomain } from 'viem';
import { normalizeSignature } from './signature.js';

/** must equal the literals in InferenceLedger's constructor. */
export const VOUCHER_DOMAIN_NAME = 'AIGGInferenceLedger';
export const VOUCHER_DOMAIN_VERSION = '1';

/** keccak256 of the exact solidity VOUCHER_TYPEHASH literal. */
export const VOUCHER_TYPEHASH: Hex = keccak256(
  stringToBytes('Voucher(address user,address provider,uint128 nonce,uint256 maxFee,uint64 expiry)'),
);

/** EIP-712 type table — field ORDER is part of the byte layout; never reorder. */
export const VOUCHER_TYPES = {
  Voucher: [
    { name: 'user', type: 'address' },
    { name: 'provider', type: 'address' },
    { name: 'nonce', type: 'uint128' },
    { name: 'maxFee', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const;

export interface Voucher {
  /** the payer — the signature must recover to this address. */
  user: Address;
  /** the service being paid — must be msg.sender at settle(). */
  provider: Address;
  /** per-(user,provider) bitmap slot (uint128) — replay guard. */
  nonce: bigint;
  /** wei-of-AI3 cap this single request may cost (uint256). */
  maxFee: bigint;
  /** unix seconds (uint64); the voucher is unusable after. */
  expiry: bigint;
}

export interface VoucherDomainParams {
  chainId: bigint | number;
  verifyingContract: Address;
}

const UINT64_MAX = (1n << 64n) - 1n;
const UINT128_MAX = (1n << 128n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;

/** range-check every field against its solidity type; throws on violation. */
export function assertVoucher(v: Voucher): void {
  if (v.nonce < 0n || v.nonce > UINT128_MAX) throw new RangeError(`voucher nonce out of uint128: ${v.nonce}`);
  if (v.maxFee < 0n || v.maxFee > UINT256_MAX) throw new RangeError(`voucher maxFee out of uint256: ${v.maxFee}`);
  if (v.expiry < 0n || v.expiry > UINT64_MAX) throw new RangeError(`voucher expiry out of uint64: ${v.expiry}`);
}

/** the full EIP-712 domain for a deployed InferenceLedger. */
export function voucherDomain(d: VoucherDomainParams): TypedDataDomain {
  return {
    name: VOUCHER_DOMAIN_NAME,
    version: VOUCHER_DOMAIN_VERSION,
    chainId: typeof d.chainId === 'bigint' ? Number(d.chainId) : d.chainId,
    verifyingContract: d.verifyingContract,
  };
}

/** hashVoucher — byte-identical to InferenceLedger.voucherDigest(v). */
export function hashVoucher(v: Voucher, d: VoucherDomainParams): Hex {
  assertVoucher(v);
  return hashTypedData({
    domain: voucherDomain(d),
    types: VOUCHER_TYPES,
    primaryType: 'Voucher',
    message: { user: v.user, provider: v.provider, nonce: v.nonce, maxFee: v.maxFee, expiry: v.expiry },
  });
}

/** the message object as viem's typed-data machinery sees it. */
export interface VoucherTypedMessage {
  user: Address;
  provider: Address;
  nonce: bigint;
  maxFee: bigint;
  expiry: bigint;
}

/** anything that can sign EIP-712 typed data (a viem account, a wallet client…). */
export interface TypedDataSigner {
  signTypedData(args: {
    domain: TypedDataDomain;
    types: typeof VOUCHER_TYPES;
    primaryType: 'Voucher';
    message: VoucherTypedMessage;
  }): Promise<Hex>;
}

/**
 * signVoucher — sign with the user's key and return the canonical 65-byte
 * r‖s‖v signature (low-s enforced, v ∈ {27,28}) the contract accepts.
 */
export async function signVoucher(signer: TypedDataSigner, v: Voucher, d: VoucherDomainParams): Promise<Hex> {
  assertVoucher(v);
  const sig = await signer.signTypedData({
    domain: voucherDomain(d),
    types: VOUCHER_TYPES,
    primaryType: 'Voucher',
    message: { user: v.user, provider: v.provider, nonce: v.nonce, maxFee: v.maxFee, expiry: v.expiry },
  });
  return normalizeSignature(sig);
}
