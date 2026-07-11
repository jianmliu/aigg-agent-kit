/**
 * Nonce bitmap helpers (extraction plan T8) — InferenceLedger tracks replay
 * per (user, provider) in 256-bit words:
 *
 *   word = nonce >> 8        bit = 1 << (nonce & 0xff)
 *
 * These helpers mirror that layout so a client can pick fresh nonces with
 * one storage read per 256 vouchers (read the word via `nonceBitmap`-style
 * views or `nonceUsed`, then scan locally).
 */

export const NONCE_MAX = (1n << 128n) - 1n;

/** the bitmap word index a nonce lives in. */
export function nonceWord(nonce: bigint): bigint {
  return nonce >> 8n;
}

/** the bit mask a nonce occupies inside its word. */
export function nonceBit(nonce: bigint): bigint {
  return 1n << (nonce & 0xffn);
}

/** true iff `nonce`'s bit is set in its word's bits. */
export function isNonceUsedInWord(wordBits: bigint, nonce: bigint): boolean {
  return (wordBits & nonceBit(nonce)) !== 0n;
}

/** lowest free nonce inside a word, or null when all 256 are used. */
export function firstFreeNonceInWord(wordBits: bigint, word: bigint): bigint | null {
  if (wordBits === (1n << 256n) - 1n) return null;
  for (let bit = 0n; bit < 256n; bit++) {
    if ((wordBits & (1n << bit)) === 0n) return word * 256n + bit;
  }
  return null;
}

/**
 * findFreeNonce — scan words from `startWord` via the injected reader (e.g.
 * a contract view call) and return the first unused nonce. Throws if the
 * uint128 space is exhausted (practically unreachable).
 */
export async function findFreeNonce(
  readWord: (word: bigint) => Promise<bigint>,
  startWord = 0n,
): Promise<bigint> {
  for (let word = startWord; word <= NONCE_MAX >> 8n; word++) {
    const free = firstFreeNonceInWord(await readWord(word), word);
    if (free !== null) return free;
  }
  throw new Error('nonce space exhausted');
}
