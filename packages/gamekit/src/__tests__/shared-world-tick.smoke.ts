/**
 * Headless smoke for the tick/DA seam — SharedWorldOptions.onEvents +
 * snapshotState() feeding TickCommitter:
 *
 *   onEvents surfaces: say (narrative, oracle-produced) + the STF receipt
 *   (affinityChanged/flagSet/burned) per talk, and the lifecycle events of
 *   the non-STF write paths (npcCreated/donated). snapshotState() rebuilds
 *   the full WorldState from the Store (registry + REL_INDEX enumeration).
 *   TickCommitter archives the tick blob (fake drive), anchors stateRoot +
 *   eventsHash (fake anchor), and verifyTickBlob proves tamper-evidence.
 *
 * Run: pnpm --filter @aigg/gamekit test:tick
 */
import assert from 'node:assert/strict';
import { InMemoryStore, type InferenceProvider, type InferenceRequest, type InferenceResult } from '@aigg/npc-agent';
import {
  SharedWorld, TickCommitter, verifyTickBlob, stateRoot,
  type WorldEvent, type TickBlob
} from '../index';

class ScriptedProvider implements InferenceProvider {
  readonly id = 'scripted';
  async complete(_req: InferenceRequest): Promise<InferenceResult> {
    return {
      text: JSON.stringify({
        say: '客官里面请！',
        effects: [
          { kind: 'adjustRelationship', delta: 5, reason: '攀谈' },
          { kind: 'setFlag', flag: 'met_wang', value: 1 }
        ]
      }),
      usage: { model: 'scripted', inputTokens: 10, outputTokens: 10, gccCost: 0.0003 }
    };
  }
}

async function main() {
  const store = new InMemoryStore();
  const ticks: WorldEvent[][] = [[]];
  const world = new SharedWorld({
    store, provider: new ScriptedProvider(),
    onEvents: (events) => ticks[ticks.length - 1].push(...events)
  });

  // --- events: lifecycle + talk --------------------------------------------
  const id = await world.createNpc({ name: '王二', owner: 'user:A', background: '城南卖酒的老板', room: '广场', startGcc: 0.01 });
  const t = await world.talk({ npcId: id, visitorId: 'player:李逍遥', text: '老板，来壶酒！' });
  await world.donate('user:C', id, 0.005);

  const tick0 = ticks[0];
  const kinds = tick0.map((e) => e.kind);
  assert.ok(kinds.includes('npcCreated'), 'lifecycle: npcCreated surfaced');
  assert.ok(kinds.includes('say'), 'narrative: say surfaced (oracle line, invisible to the STF)');
  assert.ok(kinds.includes('affinityChanged'), 'STF receipt: affinityChanged surfaced');
  assert.ok(kinds.includes('flagSet'), 'STF receipt: flagSet surfaced — its ONLY durable record');
  assert.ok(kinds.includes('burned'), 'STF receipt: burned surfaced');
  assert.ok(kinds.includes('donated'), 'lifecycle: donated surfaced');
  const say = tick0.find((e) => e.kind === 'say') as { text: string };
  assert.equal(say.text, t.said, 'say event carries the spoken line');
  // order within the talk: say precedes its STF receipt
  assert.ok(kinds.indexOf('say') < kinds.indexOf('affinityChanged'), 'say leads the talk receipt');

  // --- snapshotState: full WorldState rebuilt from the Store -----------------
  const snap = await world.snapshotState();
  assert.deepEqual(snap.registry, [id], 'registry enumerated');
  assert.equal(snap.npcs[id]?.name, '王二', 'npc record present');
  assert.ok(Math.abs(snap.balances[id] - (0.01 - t.costGcc + 0.005)) < 1e-9, 'balance = seed - burn + donation');
  const rk = `${id}|player:李逍遥`;
  assert.equal(snap.relationships[rk]?.affinity, 5, 'relationship enumerated via REL_INDEX');
  assert.deepEqual(snap.flags, {}, 'flags empty by design (event stream is their record)');

  // determinism: same store → same stateRoot
  assert.equal(stateRoot(snap), stateRoot(await world.snapshotState()), 'snapshot stateRoot is stable');

  // --- TickCommitter over the seam (fake drive + fake anchor) ----------------
  const blobs = new Map<string, string>();
  const drive = { upload: async (body: string, name: string) => { blobs.set(`cid:${name}`, body); return `cid:${name}`; }, download: async (cid: string) => blobs.get(cid)! };
  const anchored: Array<{ tick: number; stateRoot: string; eventsHash: string }> = [];
  const anchor = { commit: async (tick: number, sr: `0x${string}`, eh: `0x${string}`) => { anchored.push({ tick, stateRoot: sr, eventsHash: eh }); return { txHash: '0xfake' }; } };
  const committer = new TickCommitter(drive as never, anchor, { schema: 'pal/tick@0' });

  const result = await committer.commit(snap, tick0, 0, { host: 'tick-smoke' });
  assert.equal(result.stateRoot, `0x${stateRoot(snap)}`, 'anchored stateRoot matches the snapshot');
  assert.equal(anchored[0].eventsHash, result.eventsHash, 'anchor received the events hash');

  // tamper-evidence: the DSN body verifies against the on-chain anchor; a
  // mutated body does not.
  const body = await drive.download(result.cid);
  assert.ok(verifyTickBlob(body, result.eventsHash), 'blob verifies against the anchor');
  assert.ok(!verifyTickBlob(body.replace('客官里面请', '改过的台词'), result.eventsHash), 'tampered blob fails verification');
  const parsed = JSON.parse(body) as TickBlob;
  assert.equal(parsed.schema, 'pal/tick@0', 'host blob schema honored');
  assert.equal(parsed.events.length, tick0.length, 'full event stream archived');

  // --- a second tick: drain → new events only --------------------------------
  ticks.push([]);
  await world.talk({ npcId: id, visitorId: 'player:李逍遥', text: '再来一壶' });
  const r2 = await committer.commit(await world.snapshotState(), ticks[1], 1);
  assert.notEqual(r2.stateRoot, result.stateRoot, 'state advanced between ticks');
  assert.equal(anchored.length, 2, 'two anchors committed');

  console.log('✓ onEvents (say+STF receipt+lifecycle) / snapshotState (registry+REL_INDEX, stable root) / TickCommitter (DSN blob + anchor + tamper-evidence + host schema)');
  console.log('\nSHARED-WORLD-TICK SMOKE PASSED ✅');
}

main().catch((err) => { console.error('SHARED-WORLD-TICK SMOKE FAILED ❌', err); process.exit(1); });
