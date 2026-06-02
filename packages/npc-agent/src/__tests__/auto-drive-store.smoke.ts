/**
 * Headless smoke test for AutoDriveStore (permanent memory, phase 1) — no real
 * Auto Drive / network. A Map-backed fake AutoDriveClient stands in for the DSN;
 * an InMemoryStore is the local head-index. Proves: set→get round-trip, the
 * append-only memory chain (history), delete drops only the pointer (blobs
 * remain), and onchain CID tracking.
 *
 * Run: pnpm --filter @onchainpal/npc-agent test:autodrive
 */
import assert from 'node:assert/strict';
import { AutoDriveStore, InMemoryStore, type AutoDriveClient } from '../index';

// Fake DSN: content-addressed by a deterministic counter (stands in for CIDs).
function makeFakeClient() {
  const blobs = new Map<string, string>();
  let n = 0;
  const client: AutoDriveClient = {
    async upload(data) {
      const cid = `cid-${++n}`;
      blobs.set(cid, data);
      return cid;
    },
    async download(cid) {
      if (!blobs.has(cid)) throw new Error(`no blob ${cid}`);
      return blobs.get(cid) as string;
    }
  };
  return { client, blobs };
}

const NPC = 'npc:jiu-jianxian';
const PLAYER = 'player:hero';
const scope = { type: 'npc-player', npcId: NPC, playerId: PLAYER } as const;

async function test1_roundTripAndChain() {
  const { client, blobs } = makeFakeClient();
  let clock = 1000;
  const store = new AutoDriveStore({ client, headIndex: new InMemoryStore(), now: () => clock++ });

  // three milestone snapshots of the relationship
  await store.set(scope, 'relationship', { affinity: 15, tags: ['drinking-buddy'] }, { onchain: true });
  await store.set(scope, 'relationship', { affinity: 25, tags: ['drinking-buddy'] }, { onchain: true });
  await store.set(scope, 'relationship', { affinity: 40, tags: ['drinking-buddy', 'sworn-friend'] }, { onchain: true });

  const head = await store.get<{ affinity: number; tags: string[] }>(scope, 'relationship');
  assert.equal(head?.affinity, 40, 'get returns latest chain head');
  assert.deepEqual(head?.tags, ['drinking-buddy', 'sworn-friend']);

  const history = await store.history<{ affinity: number }>(scope, 'relationship');
  assert.equal(history.length, 3, 'memory chain has all 3 snapshots');
  assert.deepEqual(history.map((h) => h.value.affinity), [40, 25, 15], 'history newest → oldest');
  assert.equal(history[0].timestamp, 1002, 'timestamps from injected clock');
  assert.equal(store.onchainCids.size, 3, 'all onchain-tagged uploads tracked for future anchoring');
  assert.equal(blobs.size, 3, 'three immutable blobs on the DSN (append-only, nothing overwritten)');
  console.log('✓ test1 round-trip + append-only memory chain (3 snapshots, newest→oldest)');
}

async function test2_encryptionIsClientConcern() {
  // The store hands plaintext JSON to client.upload; the REAL client encrypts via
  // Auto Drive's password. Assert the store serializes the node (value + prev link).
  const { client, blobs } = makeFakeClient();
  const store = new AutoDriveStore({ client, headIndex: new InMemoryStore(), now: () => 1 });
  await store.set(scope, 'note', { text: '请过酒' });
  const stored = [...blobs.values()][0];
  const node = JSON.parse(stored);
  assert.deepEqual(node.v, { text: '请过酒' }, 'node carries the value');
  assert.equal(node.p, null, 'root node has null prev');
  console.log('✓ test2 node shape {v,p,t}; encryption is the client/SDK concern (password)');
}

async function test3_deleteDropsPointerOnly() {
  const { client, blobs } = makeFakeClient();
  const store = new AutoDriveStore({ client, headIndex: new InMemoryStore(), now: () => 1 });
  await store.set(scope, 'relationship', { affinity: 5 });
  await store.delete(scope, 'relationship');
  assert.equal(await store.get(scope, 'relationship'), null, 'pointer dropped → get null');
  assert.equal(blobs.size, 1, 'DSN blob remains (permanent — cannot be unpublished)');
  console.log('✓ test3 delete drops local pointer only; DSN blob is permanent');
}

async function main() {
  await test1_roundTripAndChain();
  await test2_encryptionIsClientConcern();
  await test3_deleteDropsPointerOnly();
  console.log('\nALL AUTO-DRIVE-STORE SMOKE TESTS PASSED ✅');
}

main().catch((err) => {
  console.error('AUTO-DRIVE-STORE SMOKE TEST FAILED ❌', err);
  process.exit(1);
});
