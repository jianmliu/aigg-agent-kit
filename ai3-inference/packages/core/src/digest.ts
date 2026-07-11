/**
 * Response digest — the 32-byte payload a gateway response signature binds:
 *
 *   keccak256( requestHash ‖ responseHash ‖ utf8(model) ‖ be64(inputTokens) ‖ be64(outputTokens) )
 *
 * and its EIP-191 personal-sign envelope:
 *
 *   keccak256("\x19Ethereum Signed Message:\n32" ‖ digest)
 *
 * This is the REFERENCE implementation — byte-identical to the Go signer
 * (aigg-src backend/internal/service/attest.PayloadDigest / eip191Hash) and to
 * @ai3-inference/verify's AutoInf attestation module. The shared fixture
 * ../vectors/digest-vectors.json is asserted on both sides (TS test here, Go
 * test in aigg-src) so the two languages cannot drift silently.
 */
import { concat, hexToBytes, keccak256, numberToBytes, stringToBytes, type Hex } from 'viem';

const UINT64_MAX = (1n << 64n) - 1n;

/** The metered fields a response signature binds. */
export interface ResponseDigestFields {
  requestHash: Hex; // 0x…32 bytes: keccak256 of the canonical request payload
  responseHash: Hex; // 0x…32 bytes: keccak256 of the response body (post-stream)
  model: string; // resolved upstream model id
  inputTokens: number | bigint; // metered prompt tokens (uint64)
  outputTokens: number | bigint; // metered completion tokens (uint64)
}

function asUint64(v: number | bigint, field: string): bigint {
  const b = typeof v === 'bigint' ? v : BigInt(v);
  if (b < 0n || b > UINT64_MAX) throw new RangeError(`${field} out of uint64 range: ${b}`);
  return b;
}

function hash32(v: Hex, field: string): Uint8Array {
  const bytes = hexToBytes(v);
  if (bytes.length !== 32) throw new RangeError(`${field} must be 32 bytes, got ${bytes.length}`);
  return bytes;
}

/** computeResponseDigest — see module doc. Pure; throws only on malformed input. */
export function computeResponseDigest(f: ResponseDigestFields): Hex {
  const packed = concat([
    hash32(f.requestHash, 'requestHash'),
    hash32(f.responseHash, 'responseHash'),
    stringToBytes(f.model),
    numberToBytes(asUint64(f.inputTokens, 'inputTokens'), { size: 8 }),
    numberToBytes(asUint64(f.outputTokens, 'outputTokens'), { size: 8 }),
  ]);
  return keccak256(packed);
}

/**
 * eip191DigestHash — the hash the enclave key actually signs. Kept explicit
 * (rather than relying on a library's hashMessage) so the fixture pins the
 * envelope too; the length suffix is always 32 because the payload is a digest.
 */
export function eip191DigestHash(digest: Hex): Hex {
  const payload = hash32(digest, 'digest');
  const prefix = stringToBytes('\x19Ethereum Signed Message:\n32');
  return keccak256(concat([prefix, payload]));
}
