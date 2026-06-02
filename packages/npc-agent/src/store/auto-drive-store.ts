import type { Store, Scope, WriteOptions } from './store';

/**
 * AutoDriveClient — minimal content-addressed blob client (an upload→CID /
 * download-by-CID pair). The real impl wraps @autonomys/auto-drive (Autonomys
 * Auto Drive, permanent DSN storage, native password encryption); tests inject a
 * Map-backed fake. Engine-neutral: AutoDriveStore depends only on this interface.
 */
export interface AutoDriveClient {
  /** upload bytes (as a UTF-8 string) → returns the content CID. */
  upload(data: string, name: string): Promise<string>;
  /** download by CID → the UTF-8 string. */
  download(cid: string): Promise<string>;
}

/** A node in an NPC's permanent memory chain (append-only linked list of CIDs). */
interface ChainNode<T> {
  v: T;
  /** previous node's CID (null at the chain root). */
  p: string | null;
  /** epoch ms. */
  t: number;
}

export interface AutoDriveStoreOptions {
  client: AutoDriveClient;
  /**
   * Local pointer store mapping (scope,key) → current head CID. Auto Drive is
   * content-addressed (no "latest by key"), so the head must be indexed
   * somewhere queryable. Phase 1: a local Store (e.g. StorageAdapterStore).
   * Phase 2 (auto-respawn): anchor the head CID on-chain for recoverability.
   */
  headIndex: Store;
  now?: () => number;
}

const headKey = (key: string) => `__cid__:${key}`;

export interface MemoryHistoryEntry<T> {
  value: T;
  cid: string;
  timestamp: number;
}

/**
 * AutoDriveStore — a durable, permanent `Store` backed by Auto Drive, modelled as
 * a per-(scope,key) **memory chain**: each `set` uploads a node {value, prevCid}
 * and advances the head pointer, giving an append-only, verifiable history (the
 * autonomys auto-memory pattern) instead of overwriting.
 *
 * This is the `onchain: true` / permanent tier of the Store seam. Use it at
 * SNAPSHOT/MILESTONE cadence (per-turn working state stays in the local
 * StorageAdapterStore, ④) — every `set` is a DSN upload. Encryption is handled
 * by the client (Auto Drive's native password), required for player×NPC memory
 * on a public DSN. `delete` only drops the local head pointer — DSN data is
 * permanent and cannot be unpublished.
 */
export class AutoDriveStore implements Store {
  private readonly client: AutoDriveClient;
  private readonly headIndex: Store;
  private readonly now: () => number;
  /** CIDs written with { onchain: true } this session — future on-chain anchor set. */
  readonly onchainCids = new Set<string>();

  constructor(options: AutoDriveStoreOptions) {
    this.client = options.client;
    this.headIndex = options.headIndex;
    this.now = options.now ?? (() => Date.now());
  }

  async get<T>(scope: Scope, key: string): Promise<T | null> {
    const cid = await this.headIndex.get<string>(scope, headKey(key));
    if (!cid) return null;
    const node = JSON.parse(await this.client.download(cid)) as ChainNode<T>;
    return node.v;
  }

  async set<T>(scope: Scope, key: string, value: T, opts?: WriteOptions): Promise<void> {
    const prev = await this.headIndex.get<string>(scope, headKey(key));
    const node: ChainNode<T> = { v: value, p: prev ?? null, t: this.now() };
    const cid = await this.client.upload(JSON.stringify(node), `${key}.json`);
    await this.headIndex.set(scope, headKey(key), cid, opts);
    if (opts?.onchain) this.onchainCids.add(cid);
  }

  /** drops the local head pointer only — DSN nodes remain (permanent). */
  async delete(scope: Scope, key: string): Promise<void> {
    await this.headIndex.delete(scope, headKey(key));
  }

  /** walk the memory chain newest → oldest (the auto-memory linked-list reconstruction). */
  async history<T>(scope: Scope, key: string): Promise<MemoryHistoryEntry<T>[]> {
    let cid = await this.headIndex.get<string>(scope, headKey(key));
    const out: MemoryHistoryEntry<T>[] = [];
    while (cid) {
      const node = JSON.parse(await this.client.download(cid)) as ChainNode<T>;
      out.push({ value: node.v, cid, timestamp: node.t });
      cid = node.p;
    }
    return out;
  }
}
