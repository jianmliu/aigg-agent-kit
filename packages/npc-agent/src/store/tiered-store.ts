import type { Store, Scope, WriteOptions } from './store';

/**
 * Decide which writes are mirrored to the permanent archive tier. Receives the
 * same (scope, key, opts) as `Store.set`.
 */
export type ArchivePredicate = (scope: Scope, key: string, opts?: WriteOptions) => boolean;

/**
 * Default policy: archive durable, identity-bearing on-chain state but NOT the
 * volatile per-turn balance (keys ending `:gcc`). Rationale — the permanent DSN
 * tier (AutoDriveStore) uploads on every `set`, so it belongs at snapshot /
 * milestone cadence: an NPC's identity (background), its relationship memory and
 * the world registry are durable; its GCC balance changes every turn and stays
 * in the hot tier.
 */
export const durableExceptBalance: ArchivePredicate = (_scope, key, opts) =>
  !!opts?.onchain && !key.endsWith(':gcc');

export interface TieredStoreOptions {
  /** Fast working tier — ALL reads and writes go here (e.g. InMemoryStore, MudStore). */
  hot: Store;
  /** Permanent tier — writes matching `archived` are ALSO mirrored here (e.g. AutoDriveStore → DSN). */
  archive: Store;
  /** Which writes to mirror to the archive. Default: {@link durableExceptBalance}. */
  archived?: ArchivePredicate;
  /**
   * On a hot-tier read miss, fall back to the archive (recover from the permanent
   * record). Off by default; turn on to rebuild a fresh hot tier from DSN
   * (auto-respawn / new-replica bootstrap).
   */
  readThrough?: boolean;
}

/**
 * TieredStore — composes a fast **hot** tier with a permanent **archive** tier
 * behind the single `Store` seam, so callers (SharedWorld, the runtime) are
 * unchanged. Durable identity + memory are mirrored to the archive (DSN permanent
 * layer); volatile working state stays hot. With `readThrough`, a cold hot tier
 * recovers state from the archive — the basis of NPC auto-respawn from a permanent
 * memory chain.
 *
 * `delete` is a hot-tier operation only: the archive (Auto Drive / DSN) is an
 * append-only permanent record and is never unpublished. Drop the archive head
 * pointer explicitly if you must forget it locally.
 */
export class TieredStore implements Store {
  private readonly hot: Store;
  private readonly archive: Store;
  private readonly archived: ArchivePredicate;
  private readonly readThrough: boolean;
  /** `scope.type|key` of every write mirrored to the archive this session (trace/metrics). */
  readonly archivedKeys = new Set<string>();

  constructor(opts: TieredStoreOptions) {
    this.hot = opts.hot;
    this.archive = opts.archive;
    this.archived = opts.archived ?? durableExceptBalance;
    this.readThrough = opts.readThrough ?? false;
  }

  async get<T>(scope: Scope, key: string): Promise<T | null> {
    const hit = await this.hot.get<T>(scope, key);
    if (hit !== null || !this.readThrough) return hit;
    return this.archive.get<T>(scope, key); // recover from the permanent tier
  }

  async set<T>(scope: Scope, key: string, value: T, opts?: WriteOptions): Promise<void> {
    await this.hot.set(scope, key, value, opts);
    if (this.archived(scope, key, opts)) {
      await this.archive.set(scope, key, value, opts);
      this.archivedKeys.add(`${scope.type}|${key}`);
    }
  }

  async delete(scope: Scope, key: string): Promise<void> {
    await this.hot.delete(scope, key);
  }
}
