/**
 * PR-B step 2 smoke — crossServerStable write-tiering predicate.
 *
 * Proves the "hot data never costs a transaction" invariant: when the archive
 * (shared) tier's head index is on-chain, only the STABLE cross-server subset —
 * world-scoped NPC identity (`npc:<id>`) + registry (`world:npcs`) — is mirrored
 * to it. HOT per-visitor state — relationships (`npc-player` scope) and the GCC
 * balance (`:gcc`) — stays local and NEVER hits the shared tier, so a busy
 * conversation generates ZERO shared-tier writes (= zero on-chain txs).
 *
 * Run: tsx src/__tests__/cross-server-tiering.smoke.ts
 */
import assert from 'node:assert/strict';
import { InMemoryStore } from '../memory/memory-store';
import { TieredStore, crossServerStable, durableExceptBalance } from '../store/tiered-store';
import type { Store, Scope, WriteOptions } from '../store/store';

/** archive that counts every write it receives — the "shared tier" (on-chain head). */
class CountingArchive implements Store {
  readonly writes: string[] = [];
  private readonly inner = new InMemoryStore();
  async get<T>(s: Scope, k: string) { return this.inner.get<T>(s, k); }
  async set<T>(s: Scope, k: string, v: T, o?: WriteOptions) { this.writes.push(`${s.type}|${k}`); return this.inner.set(s, k, v, o); }
  async delete(s: Scope, k: string) { return this.inner.delete(s, k); }
}

const W: Scope = { type: 'world' };
const rel = (npcId: string, playerId: string): Scope => ({ type: 'npc-player', npcId, playerId });
const ON = { onchain: true } as const;

async function main() {
  // ── 1. predicate truth table ────────────────────────────────────────────────
  assert.equal(crossServerStable(W, 'npc:npc:酒剑仙', ON), true, 'NPC identity → shared');
  assert.equal(crossServerStable(W, 'world:npcs', ON), true, 'registry → shared');
  assert.equal(crossServerStable(W, 'npc:npc:酒剑仙:gcc', ON), false, 'GCC balance → local only');
  assert.equal(crossServerStable(rel('npc:酒剑仙', 'player:V'), 'relationship', ON), false, 'relationship → local only');
  assert.equal(crossServerStable(W, 'npc:npc:酒剑仙', undefined), false, 'untagged write → not shared');
  console.log('  ✓ predicate truth table: identity+registry shared; balance+relationship local');

  // ── 2. through TieredStore: a full create+activate+converse never over-writes ─
  const archive = new CountingArchive();
  const store = new TieredStore({ hot: new InMemoryStore(), archive, readThrough: true, archived: crossServerStable });

  // author + activate an NPC (the stable events that SHOULD cross servers)
  await store.set(W, 'npc:npc:酒剑仙', { id: 'npc:酒剑仙', name: '酒剑仙', owner: 'player:A', room: '酒馆' }, ON);
  await store.set(W, 'world:npcs', ['npc:酒剑仙'], ON);
  await store.set(W, 'npc:npc:酒剑仙:gcc', 0.01, ON);              // balance — local
  const afterAuthor = archive.writes.length;
  assert.equal(afterAuthor, 2, 'only identity + registry crossed to shared tier (not balance)');

  // now simulate 50 conversation turns: each updates a relationship + burns gcc
  for (let i = 0; i < 50; i++) {
    await store.set(rel('npc:酒剑仙', `player:V${i % 5}`), 'relationship', { affinity: i }, ON);
    await store.set(W, 'npc:npc:酒剑仙:gcc', 0.01 - i * 0.0001, ON);
  }
  assert.equal(archive.writes.length, afterAuthor, '50 conversation turns → ZERO new shared-tier writes (no tx per turn)');
  console.log(`  ✓ 50 turns of relationship+balance churn → 0 shared-tier writes (stayed at ${afterAuthor})`);

  // ── 3. but hot tier kept everything locally (readable) ──────────────────────
  assert.deepEqual(await store.get(rel('npc:酒剑仙', 'player:V0'), 'relationship'), { affinity: 45 }, 'relationship readable from local hot');
  assert.equal(await store.get(W, 'npc:npc:酒剑仙:gcc'), 0.01 - 49 * 0.0001, 'balance readable from local hot');
  console.log('  ✓ hot tier retains relationships + balance locally (full fidelity)');

  // ── 4. contrast: durableExceptBalance WOULD have flooded the shared tier ─────
  const archive2 = new CountingArchive();
  const store2 = new TieredStore({ hot: new InMemoryStore(), archive: archive2, archived: durableExceptBalance });
  await store2.set(rel('npc:酒剑仙', 'player:V'), 'relationship', { affinity: 1 }, ON);
  assert.equal(archive2.writes.length, 1, 'durableExceptBalance mirrors relationships (would be a tx/turn on-chain)');
  console.log('  ✓ contrast: durableExceptBalance archives relationships — wrong for an on-chain head');

  console.log('\nCROSS-SERVER-TIERING (PR-B step 2) SMOKE PASSED ✅');
}

main().catch((err) => { console.error('CROSS-SERVER-TIERING SMOKE FAILED ❌', err); process.exit(1); });
