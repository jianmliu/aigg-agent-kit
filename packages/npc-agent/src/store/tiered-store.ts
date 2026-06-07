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

/**
 * Cross-server policy: mirror to the shared tier ONLY the stable, cross-server
 * subset — world-scoped **NPC identity** (`npc:<id>`) and the **registry**
 * (`world:npcs`). Everything else stays local.
 *
 * Why narrower than {@link durableExceptBalance}: when the archive's head index
 * is ON-CHAIN (MudStore → KvWorld, the trustless cross-server head pointer),
 * every mirrored write costs a transaction. HOT per-visitor state —
 * relationships (`npc-player` scope) and the GCC balance (`:gcc`) — changes
 * every conversation, so it must NOT hit the shared tier per turn. It stays in
 * the local warm tier and is reconciled to the shared world only at milestones.
 * The result: a second server recovers WHICH NPCs exist and their identity from
 * chain + DSN, while routine conversation never touches the chain.
 */
export const crossServerStable: ArchivePredicate = (scope, key, opts) => {
  if (!opts?.onchain) return false;
  if (scope.type !== 'world') return false;     // relationships (npc-player) stay local
  if (key.endsWith(':gcc')) return false;       // volatile balance stays local
  return key === 'world:npcs' || key.startsWith('npc:'); // registry + NPC identity
};

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
  /**
   * Mirror to the archive in the BACKGROUND (write-behind) instead of blocking
   * the caller. The hot write still completes synchronously (durable locally);
   * the archive mirror (slow DSN upload + on-chain head write) is queued and
   * retried, so an activation/move isn't blocked for seconds. Failed writes are
   * reported via `onArchiveError`. Call `flush()` before shutdown to drain.
   * Default false (synchronous mirror).
   */
  asyncArchive?: boolean;
  /** retry attempts for a background archive write before giving up. Default 3. */
  archiveRetries?: number;
  /** invoked when a background archive write ultimately fails (after retries). */
  onArchiveError?: (scope: Scope, key: string, err: unknown) => void;
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
  private readonly asyncArchive: boolean;
  private readonly archiveRetries: number;
  private readonly onArchiveError?: (scope: Scope, key: string, err: unknown) => void;
  /** serialized write-behind queue (preserves order; one archive write at a time). */
  private queue: Promise<void> = Promise.resolve();
  /** count of in-flight background archive writes (inspectable by tests). */
  private inflight = 0;
  /** `scope.type|key` of every write mirrored to the archive this session (trace/metrics). */
  readonly archivedKeys = new Set<string>();

  constructor(opts: TieredStoreOptions) {
    this.hot = opts.hot;
    this.archive = opts.archive;
    this.archived = opts.archived ?? durableExceptBalance;
    this.readThrough = opts.readThrough ?? false;
    this.asyncArchive = opts.asyncArchive ?? false;
    this.archiveRetries = opts.archiveRetries ?? 3;
    this.onArchiveError = opts.onArchiveError;
  }

  async get<T>(scope: Scope, key: string): Promise<T | null> {
    const hit = await this.hot.get<T>(scope, key);
    if (hit !== null || !this.readThrough) return hit;
    return this.archive.get<T>(scope, key); // recover from the permanent tier
  }

  async set<T>(scope: Scope, key: string, value: T, opts?: WriteOptions): Promise<void> {
    await this.hot.set(scope, key, value, opts);
    if (!this.archived(scope, key, opts)) return;
    if (this.asyncArchive) {
      this.enqueueArchive(scope, key, value, opts); // write-behind — don't block the caller
    } else {
      await this.archive.set(scope, key, value, opts);
      this.archivedKeys.add(`${scope.type}|${key}`);
    }
  }

  /** enqueue a background archive write (serialized, retried, never throws to caller). */
  private enqueueArchive<T>(scope: Scope, key: string, value: T, opts?: WriteOptions): void {
    this.inflight++;
    this.queue = this.queue.then(async () => {
      try {
        let lastErr: unknown;
        for (let attempt = 0; attempt < this.archiveRetries; attempt++) {
          try { await this.archive.set(scope, key, value, opts); this.archivedKeys.add(`${scope.type}|${key}`); return; }
          catch (e) { lastErr = e; }
        }
        this.onArchiveError?.(scope, key, lastErr);
      } finally {
        this.inflight--;
      }
    });
  }

  /** drain all pending background archive writes (call before shutdown). */
  async flush(): Promise<void> { await this.queue; }

  /** number of background archive writes still pending. */
  pendingArchiveWrites(): number { return this.inflight; }

  async delete(scope: Scope, key: string): Promise<void> {
    await this.hot.delete(scope, key);
  }
}
