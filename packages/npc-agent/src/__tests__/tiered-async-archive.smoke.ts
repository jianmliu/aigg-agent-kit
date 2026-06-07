/**
 * Smoke — TieredStore write-behind archive (asyncArchive). The hot write
 * completes synchronously (durable locally); the slow archive mirror (DSN
 * upload + on-chain head) is queued + retried so an activation/move isn't
 * blocked for seconds. flush() drains; onArchiveError reports final failures.
 *
 * Run: tsx src/__tests__/tiered-async-archive.smoke.ts
 */
import assert from 'node:assert/strict';
import { InMemoryStore } from '../memory/memory-store';
import { TieredStore } from '../store/tiered-store';
import type { Store, Scope, WriteOptions } from '../store/store';

const W: Scope = { type: 'world' };
const ON = { onchain: true } as const;
const tick = () => new Promise((r) => setTimeout(r, 0));

/** archive whose set() blocks until released — models a slow DSN/on-chain write. */
class GatedArchive implements Store {
  readonly inner = new InMemoryStore();
  private release!: () => void;
  gate = new Promise<void>((r) => { this.release = r; });
  sets = 0;
  open() { this.release(); }
  async get<T>(s: Scope, k: string) { return this.inner.get<T>(s, k); }
  async set<T>(s: Scope, k: string, v: T, o?: WriteOptions) { await this.gate; this.sets++; return this.inner.set(s, k, v, o); }
  async delete(s: Scope, k: string) { return this.inner.delete(s, k); }
}

/** archive that fails the first `failures` attempts, then succeeds. */
class FlakyArchive implements Store {
  readonly inner = new InMemoryStore();
  attempts = 0;
  constructor(private failures: number) {}
  async get<T>(s: Scope, k: string) { return this.inner.get<T>(s, k); }
  async set<T>(s: Scope, k: string, v: T, o?: WriteOptions) { if (this.attempts++ < this.failures) throw new Error('archive flaky'); return this.inner.set(s, k, v, o); }
  async delete(s: Scope, k: string) { return this.inner.delete(s, k); }
}

async function main() {
  // ── 1. set() returns BEFORE the slow archive write completes ────────────────
  const gated = new GatedArchive();
  const hot = new InMemoryStore();
  const store = new TieredStore({ hot, archive: gated, readThrough: true, asyncArchive: true });

  await store.set(W, 'npc:酒剑仙', { name: '酒剑仙' }, ON); // returns immediately (archive still gated)
  assert.equal(gated.sets, 0, 'archive write has NOT completed yet (not blocked)');
  assert.equal(store.pendingArchiveWrites(), 1, 'one background archive write pending');
  assert.deepEqual(await hot.get(W, 'npc:酒剑仙'), { name: '酒剑仙' }, 'hot write IS durable immediately');
  console.log('  ✓ set() returns before slow archive completes; hot write durable; 1 pending');

  // release the gate + drain
  gated.open();
  await store.flush();
  assert.equal(store.pendingArchiveWrites(), 0, 'queue drained after flush');
  assert.deepEqual(await gated.get(W, 'npc:酒剑仙'), { name: '酒剑仙' }, 'archive eventually has the value');
  console.log('  ✓ flush() drains → archive eventually consistent');

  // ── 2. retry: a flaky archive succeeds after retries ────────────────────────
  const flaky = new FlakyArchive(2); // fail twice, succeed on the 3rd
  const store2 = new TieredStore({ hot: new InMemoryStore(), archive: flaky, asyncArchive: true, archiveRetries: 3 });
  await store2.set(W, 'npc:碧玄子', { name: '碧玄子' }, ON);
  await store2.flush();
  assert.equal(flaky.attempts, 3, 'retried until success (3 attempts)');
  assert.deepEqual(await flaky.get(W, 'npc:碧玄子'), { name: '碧玄子' }, 'archived after retries');
  console.log('  ✓ flaky archive → retried to success');

  // ── 3. onArchiveError fires when all retries fail (never throws to caller) ───
  const errors: string[] = [];
  const store3 = new TieredStore({
    hot: new InMemoryStore(), archive: new FlakyArchive(99), asyncArchive: true, archiveRetries: 2,
    onArchiveError: (_s, k) => errors.push(k),
  });
  await store3.set(W, 'npc:doomed', { x: 1 }, ON); // does not throw despite archive failing
  await store3.flush();
  assert.deepEqual(errors, ['npc:doomed'], 'onArchiveError reported the failed key after retries');
  console.log('  ✓ permanent failure → onArchiveError (caller never throws)');

  // ── 4. sync mode unchanged (default) ────────────────────────────────────────
  const syncArchive = new InMemoryStore();
  const store4 = new TieredStore({ hot: new InMemoryStore(), archive: syncArchive }); // asyncArchive default false
  await store4.set(W, 'npc:sync', { y: 2 }, ON);
  assert.deepEqual(await syncArchive.get(W, 'npc:sync'), { y: 2 }, 'sync mode mirrors before set() resolves');
  await tick();
  console.log('  ✓ sync mode (default) unchanged');

  console.log('\nTIERED-ASYNC-ARCHIVE SMOKE PASSED ✅');
}

main().catch((err) => { console.error('TIERED-ASYNC-ARCHIVE SMOKE FAILED ❌', err); process.exit(1); });
