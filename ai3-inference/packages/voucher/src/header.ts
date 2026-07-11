/**
 * Voucher transport headers (extraction plan T9; market spec §4.1) — the
 * wire protocol both sides share: a client sends the voucher + its EIP-712
 * signature on every request to a voucher-gated endpoint; the gateway's
 * middleware decodes, verifies, and meters against it.
 *
 *   X-AIGG-Voucher       canonical JSON (fixed field order, bigints as
 *                        decimal strings — pure ASCII, header-safe)
 *   X-AIGG-Voucher-Sig   65-byte r‖s‖v hex from signVoucher()
 *
 * Rejection is HTTP 402 with a JSON body: {"error": "...", and for
 * fee-estimate failures "estimateWei": "<decimal>"} so a client can re-sign
 * a bigger voucher.
 */
import { getAddress, type Address } from 'viem';
import { assertVoucher, type Voucher } from './voucher.js';

export const VOUCHER_HEADERS = {
  voucher: 'x-aigg-voucher',
  signature: 'x-aigg-voucher-sig',
} as const;

/** canonical JSON encoding — fixed field order, decimal-string bigints. */
export function encodeVoucher(v: Voucher): string {
  assertVoucher(v);
  return JSON.stringify({
    user: getAddress(v.user),
    provider: getAddress(v.provider),
    nonce: v.nonce.toString(),
    maxFee: v.maxFee.toString(),
    expiry: v.expiry.toString(),
  });
}

/** parse + range-validate a header value; throws on any malformed field. */
export function decodeVoucher(encoded: string): Voucher {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(encoded) as Record<string, unknown>;
  } catch {
    throw new Error('[voucher] header is not valid JSON');
  }
  const dec = (field: string): bigint => {
    const s = raw[field];
    if (typeof s !== 'string' || !/^\d+$/.test(s)) throw new Error(`[voucher] ${field} must be a decimal string`);
    return BigInt(s);
  };
  const addr = (field: string): Address => {
    const s = raw[field];
    if (typeof s !== 'string') throw new Error(`[voucher] ${field} must be an address string`);
    return getAddress(s); // throws on malformed/bad-checksum input
  };
  const v: Voucher = {
    user: addr('user'),
    provider: addr('provider'),
    nonce: dec('nonce'),
    maxFee: dec('maxFee'),
    expiry: dec('expiry'),
  };
  assertVoucher(v);
  return v;
}
