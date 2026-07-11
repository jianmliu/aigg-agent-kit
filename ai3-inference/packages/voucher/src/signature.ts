/**
 * Signature canonicalization (extraction plan T8) — InferenceLedger rejects
 * malleable signatures: s must be ≤ half the curve order and v ∈ {27,28}.
 * normalizeSignature folds any valid-but-malleated signature back to the
 * canonical form ((r, s, v) → (r, N−s, v⊕1) when s is high), so a voucher
 * signed by a wallet that emits high-s still settles.
 */
import { hexToBytes, bytesToHex, type Hex } from 'viem';

/** secp256k1 curve order N and its half — the contract's SECP256K1_HALF_N. */
export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export const SECP256K1_HALF_N = SECP256K1_N >> 1n;

function splitSig(sig: Hex): { bytes: Uint8Array; s: bigint; v: number } {
  const bytes = hexToBytes(sig);
  if (bytes.length !== 65) throw new Error(`signature must be 65 bytes, got ${bytes.length}`);
  const s = BigInt(bytesToHex(bytes.slice(32, 64)));
  return { bytes, s, v: bytes[64]! };
}

/** true iff s is in the lower half of the curve order (canonical form). */
export function isLowS(sig: Hex): boolean {
  return splitSig(sig).s <= SECP256K1_HALF_N;
}

/**
 * normalizeSignature — returns the canonical low-s form, flipping v to keep
 * the recovered address identical. Also maps v ∈ {0,1} → {27,28}. Throws on
 * malformed length or an unrecognized v.
 */
export function normalizeSignature(sig: Hex): Hex {
  const { bytes, s, v } = splitSig(sig);
  let vNorm = v;
  if (vNorm === 0 || vNorm === 1) vNorm += 27;
  if (vNorm !== 27 && vNorm !== 28) throw new Error(`unrecognized signature v: ${v}`);
  const out = new Uint8Array(bytes);
  if (s > SECP256K1_HALF_N) {
    const sLow = SECP256K1_N - s;
    out.set(hexToBytes(`0x${sLow.toString(16).padStart(64, '0')}`), 32);
    vNorm = vNorm === 27 ? 28 : 27;
  }
  out[64] = vNorm;
  return bytesToHex(out);
}
