/**
 * Headless smoke: SharedWorld over a TieredStore whose archive tier is an
 * AutoDriveStore (Autonomys DSN permanent layer). Proves the NPC's IDENTITY
 * (background) and MEMORY (per-visitor relationship) are mirrored to the DSN as a
 * verifiable, permanent memory chain, while the VOLATILE balance stays in the hot
 * tier only — and that a cold replica recovers the whole world from DSN.
 *
 * A Map-backed fake AutoDriveClient stands in for ai3.storage (the real client is
 * createAutoDriveClient in game-engine). Run: pnpm --filter @onchainpal/gamekit test:dsn
 */
import assert from 'node:assert/strict';
import {
  InMemoryStore, AutoDriveStore, TieredStore, Metabolism,
  type AutoDriveClient, type Scope, type InferenceProvider, type InferenceRequest, type InferenceResult
} from '@onchainpal/npc-agent';
import { SharedWorld } from '../shared-world';

// SharedWorld's key scheme (mirrors shared-world.ts) — for asserting on the tiers.
const W: Scope = { type: 'world' };
const npcKey = (id: string) => `npc:${id}`;
const gccKey = (id: string) => `npc:${id}:gcc`;
const REL_KEY = 'relationship';

/** content-addressed in-memory DSN: every upload → a fresh permanent CID. */
class FakeAutoDrive implements AutoDriveClient {
  blobs = new Map<string, string>();
  uploads = 0;
  async upload(data: string, name: string): Promise<string> {
    const cid = `bafy:${name}:${this.uploads++}`;
    this.blobs.set(cid, data);
    return cid;
  }
  async download(cid: string): Promise<string> {
    const d = this.blobs.get(cid);
    if (d == null) throw new Error(`no blob ${cid}`);
    return d;
  }
}

class ScriptedProvider implements InferenceProvider {
  readonly id = 'scripted'; private i = 0;
  private lines = ['后生可畏，且饮一杯。', '剑意在心不在形，记住了。'];
  async complete(_req: InferenceRequest): Promise<InferenceResult> {
    return {
      text: JSON.stringify({ say: this.lines[this.i++ % this.lines.length], effects: [{ kind: 'adjustRelationship', delta: 7, reason: '论剑' }], emotion: '欣赏' }),
      usage: { model: 'scripted', inputTokens: 40, outputTokens: 30, gccCost: 0.0003 }
    };
  }
}
const metabolism = new Metabolism({ tiers: [{ id: 'r', minBalanceGcc: 0.0005, model: 'm', label: '充盈' }, { id: 'l', minBalanceGcc: 0.0001, model: 'm', label: '清醒' }], starvingBelowGcc: 0.0001, defaultTierId: 'l' });

async function main() {
  let clock = 1_700_000_000_000;
  const dsn = new FakeAutoDrive();
  const archive = new AutoDriveStore({ client: dsn, headIndex: new InMemoryStore(), now: () => ++clock });
  const hot = new InMemoryStore();
  const store = new TieredStore({ hot, archive }); // default policy: durable except `:gcc`

  const world = new SharedWorld({ store, provider: new ScriptedProvider(), metabolism });

  // --- create: identity (background) authored → DSN permanent layer -----------
  const id = await world.createNpc({
    name: '酒剑仙', owner: 'user:A', room: '酒馆', startGcc: 0.0009,
    background: '嗜酒如命的剑道高人，醉中悟出绝世剑意'
  });

  const recOnDsn = await archive.get<{ background: string; name: string }>(W, npcKey(id));
  assert.ok(recOnDsn, 'NPC identity present on DSN');
  assert.match(recOnDsn!.background, /醉中悟/, 'free-text background stored permanently on DSN');

  // it IS a memory chain (verifiable CID history), not an overwrite
  const idHist = await archive.history(W, npcKey(id));
  assert.equal(idHist.length, 1, 'identity has one chain node after create');
  assert.match(idHist[0].cid, /^bafy:/, 'identity anchored at a real CID');

  // volatile balance is NOT on DSN — hot tier only
  assert.equal(await archive.get(W, gccKey(id)), null, 'GCC balance NOT uploaded to DSN (volatile, hot-only)');
  assert.equal(await hot.get(W, gccKey(id)), 0.0009, 'balance lives in the hot tier');

  // --- talk: relationship MEMORY → DSN permanent layer ------------------------
  const t = await world.talk({ npcId: id, visitorId: 'player:游侠', text: '前辈请教剑法' });
  assert.ok(t.affinity > 0 && t.costGcc > 0, 'NPC thought on funded GCC and remembered the visitor');

  const relScope: Scope = { type: 'npc-player', npcId: id, playerId: 'player:游侠' };
  const memOnDsn = await archive.get<{ affinity: number }>(relScope, REL_KEY);
  assert.ok(memOnDsn && memOnDsn.affinity === t.affinity, 'per-visitor relationship memory mirrored to DSN');

  // the burn updated the balance in hot, but did NOT add a DSN upload for `:gcc`
  const uploadsAfterTalk = dsn.uploads;
  await world.donate('patron:Z', id, 0.001); // pure balance change
  assert.equal(dsn.uploads, uploadsAfterTalk, 'funding/donation (balance-only) does NOT touch DSN');

  // --- place: identity edit chains onto the permanent record ------------------
  await world.place(id, '广场');
  const idHist2 = await archive.history(W, npcKey(id));
  assert.equal(idHist2.length, 2, 'moving the NPC appended a new identity node (append-only chain)');
  assert.equal(idHist2[0].value !== undefined && (idHist2[0].value as any).room, '广场', 'newest node has the new room');
  assert.equal((idHist2[1].value as any).room, '酒馆', 'older node preserves the original room — permanent history');

  // --- recovery: a COLD replica rebuilds the world from DSN -------------------
  const cold = new TieredStore({ hot: new InMemoryStore(), archive, readThrough: true });
  const replica = new SharedWorld({ store: cold, provider: new ScriptedProvider(), metabolism });
  const list = await replica.listNpcs(); // registry + records recovered from DSN
  assert.equal(list.length, 1, 'cold replica recovered the NPC registry from DSN');
  assert.equal(list[0].name, '酒剑仙', 'recovered the NPC identity from the permanent layer');
  const recoveredRec = await replica.getNpc(id);
  assert.match(recoveredRec!.background, /醉中悟/, 'recovered the free-text background from DSN');
  assert.equal(await replica.balanceGcc(id), 0, 'balance is NOT recoverable from DSN (volatile, hot-only) — by design');

  // recovered replica can still read the player's memory from DSN
  const recoveredMem = await cold.get<{ affinity: number }>(relScope, REL_KEY);
  assert.ok(recoveredMem && recoveredMem.affinity > 0, 'cold replica recovered the visitor relationship from DSN');

  // --- permanence: DSN blob survives a local delete ---------------------------
  const headCid = idHist2[0].cid;
  await store.delete(W, npcKey(id));        // drops the HOT pointer
  assert.equal(await hot.get(W, npcKey(id)), null, 'identity gone from hot tier after delete');
  const stillThere = JSON.parse(await dsn.download(headCid)); // CID still resolves on DSN
  assert.equal(stillThere.v.name, '酒剑仙', 'the DSN blob is permanent — still downloadable by CID after delete');

  console.log(`✓ identity + memory on DSN as a CID chain (${dsn.uploads} permanent uploads); balance hot-only; cold replica recovered the world; DSN blobs permanent after delete`);
  console.log('\nSHARED-WORLD × DSN SMOKE PASSED ✅');
}

main().catch((err) => { console.error('SHARED-WORLD × DSN SMOKE FAILED ❌', err); process.exit(1); });
