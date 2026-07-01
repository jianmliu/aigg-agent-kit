/**
 * ZeroGTransport — the byte-level seam under ZeroGStorageClient. Real = the 0G
 * Storage SDK (built in zerog-storage.ts:fromConfig); Fake = content-addressed
 * in-memory for hermetic tests. `contentId` is what makes `verify` faithful for
 * both transports without the client knowing 0G internals.
 */
import { keccak256 } from 'ethers';

export interface ZeroGTransport {
  put(bytes: Uint8Array): Promise<string>;
  get(rootHash: string): Promise<Uint8Array>;
  contentId(bytes: Uint8Array): Promise<string>;
}

/** In-memory content-addressed transport for hermetic tests. content-id = keccak256(bytes). */
export class FakeZeroGTransport implements ZeroGTransport {
  private readonly store = new Map<string, Uint8Array>();
  async contentId(bytes: Uint8Array): Promise<string> { return keccak256(bytes); }
  async put(bytes: Uint8Array): Promise<string> {
    const id = await this.contentId(bytes);
    this.store.set(id, bytes);
    return id;
  }
  async get(rootHash: string): Promise<Uint8Array> {
    const b = this.store.get(rootHash);
    if (!b) throw new Error(`FakeZeroGTransport: no blob for ${rootHash}`);
    return b;
  }
  /** TEST-ONLY: store mismatched bytes under `rootHash` (simulates a tampered blob). */
  _putRaw(rootHash: string, bytes: Uint8Array): void { this.store.set(rootHash, bytes); }
}
