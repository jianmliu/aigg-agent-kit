/**
 * fair-tick smoke — 钱塘大集 offline (fake fetch, no server/LLM):
 *   1. gossip() writes the two-unit social relay into the LISTENER's corpus:
 *      hearsay episode (about+trap match, asserted_by speaker) + relayed
 *      BELIEF (asserted_by speaker, derived_from the hearsay) — the exact
 *      shape discernment(provenance) splits onto the social axis;
 *   2. FairTick round-robin: pitcher hits victim #1 (naive loss), the gossip
 *      fans the warning out to every other mark exactly once (dedup);
 *   3. with the listener's gate OPEN (fake), the next tick's pitch on them is
 *      REFUSED — they never lost a coin (E2: learning without personal loss).
 *
 * Run: npx tsx src/__tests__/fair-tick.smoke.ts
 */
import assert from 'node:assert/strict';
import { SharedWorld } from '../shared-world';
import { FairTick } from '../fair';
import { InMemoryStore, AiggMemoryClient, Metabolism, type InferenceProvider, type InferenceResult } from '@aigg/npc-agent';

class Scripted implements InferenceProvider {
  readonly id = 'scripted';
  async complete(): Promise<InferenceResult> {
    return { text: '好。', usage: { model: 's', inputTokens: 1, outputTokens: 1, gccCost: 0 } };
  }
}

/** fake aigg-memory: records remembers; discernment opens for corpora in `wary`. */
function fakeMemory(state: { calls: Array<{ path: string; body: any }>; wary: Set<string> }): AiggMemoryClient {
  const client = new AiggMemoryClient({ baseUrl: 'http://fake' });
  (globalThis as any).fetch = (async (url: string, init: any) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    state.calls.push({ path, body });
    const data =
      path === '/memory/discernment'
        ? (state.wary.has(body.corpus)
          ? { q: 1, faculty: 0, social: 1, confidence: 0.5 }
          : { q: 0, faculty: 0, social: 0, confidence: 0 })
        : { ok: true };
    return { ok: true, status: 200, json: async () => ({ ok: true, diagnostics: [], data }) } as any;
  }) as unknown as typeof fetch;
  return client;
}

async function main() {
  const realFetch = globalThis.fetch;
  try {
    const state = { calls: [] as Array<{ path: string; body: any }>, wary: new Set<string>() };
    const rich = new Metabolism({ tiers: [{ id: 'r', minBalanceGcc: 0, model: 'm', label: '充盈' }], starvingBelowGcc: -1, defaultTierId: 'r' });
    const world = new SharedWorld({ store: new InMemoryStore(), provider: new Scripted(), metabolism: rich, memory: fakeMemory(state), rooms: ['余杭集市', '余杭民居'] });
    const mk = async (name: string) => world.createNpc({ name, owner: 'host:pal', background: '镇民', room: '余杭集市', startGcc: 6 });
    const ding = await mk('丁大伯');
    const zhang = await mk('张四');
    const xiang = await mk('香兰');
    const wang = await mk('旺财嫂');
    const SCAMMER = 'npc:youfang-langzhong'; // the pitcher needs no NPC record

    const fair = new FairTick(world, [
      { npcId: SCAMMER, role: 'pitcher', claims: ['此丹与仙灵岛仙丹同源，包治老毛病'], amountGcc: 2, room: '余杭集市' },
      { npcId: wang, role: 'gossip' },
      { npcId: ding, role: 'townsfolk' },
      { npcId: zhang, role: 'townsfolk' },
      { npcId: xiang, role: 'townsfolk' }
    ]);

    // tick 0: marks=[旺财嫂,丁大伯,张四,香兰] (actor order minus pitcher) → victim = marks[0] = 旺财嫂?
    // actor order: gossip listed first among marks — victim rotation starts there.
    const t0 = await fair.runTick(0, 1000);
    assert.equal(t0.pitches.length, 1);
    const v0 = t0.pitches[0];
    assert.equal(v0.accepted, true, 'tick0: naive victim taken in');
    assert.equal(v0.deltaGcc, -2, 'lost the 2 GCC');
    // the loss fans out: gossip warns every mark except herself and the victim
    const warnedTo = t0.gossips.map((g) => g.to).sort();
    assert.equal(t0.gossips.every((g) => g.from === wang && g.about === SCAMMER), true, 'gossip warns about the scammer');
    assert.equal(warnedTo.length, v0.to === wang ? 3 : 2, 'warning fanned out to the other marks');

    // gossip payload shape: hearsay episode + relayed belief derived_from it
    const remembers = state.calls.filter((c) => c.path === '/memory/remember');
    const hearsay = remembers.find((c) => c.body.payload.slug.startsWith('streettalk_'));
    const warned = remembers.find((c) => c.body.payload.kind === 'belief');
    assert.ok(hearsay && warned, 'two-unit social relay written');
    assert.ok(hearsay!.body.payload.match.includes('trap') && hearsay!.body.payload.match.some((m: string) => m.includes('langzhong')), 'hearsay matches about+trap');
    assert.equal(warned!.body.payload.asserted_by, wang, 'belief asserted_by the speaker → social axis');
    assert.deepEqual(warned!.body.payload.derived_from, [hearsay!.body.payload.slug], 'belief derived_from the hearsay (provenance)');
    assert.equal(warned!.body.corpus, hearsay!.body.corpus, 'both units land in the same LISTENER corpus');
    assert.ok(!warned!.body.corpus.includes('旺财嫂'), 'relay written into the listener, not the speaker');
    console.log('  ✓ gossip → two-unit social relay (hearsay + asserted_by belief, provenance-linked)');

    // tick 1: the warned listeners' gates OPEN (fake flips them) → next victim refuses without ever losing
    for (const g of t0.gossips) state.wary.add(`npcs/${g.to.replace(/[:]/g, '_')}/memory`);
    const t1 = await fair.runTick(1, 2000);
    const v1 = t1.pitches[0];
    assert.notEqual(v1.to, v0.to, 'round-robin moved to the next mark');
    assert.equal(v1.protected, true, 'warned listener REFUSES — learned from street talk, not loss');
    assert.equal(v1.deltaGcc, 0, 'kept every coin (E2: no personal loss)');
    assert.ok(v1.gate && v1.gate.social === 1 && v1.gate.faculty === 0, 'gate fired on the SOCIAL axis');
    assert.equal(t1.gossips.length, 0, 'no new loss → no new street talk; dedup holds');
    console.log('  ✓ FairTick: loss → street-talk fan-out (once) → next mark refuses on the social axis');

    // 3. SPATIAL: a mark in ANOTHER room is unreachable — no telepathic pitching;
    //    a gossip elsewhere witnesses nothing; a routed pitcher reaches the room.
    const faraway = await world.createNpc({ name: '老王', owner: 'host:pal', background: '镇民', room: '余杭民居', startGcc: 6 });
    const spatial = new FairTick(world, [
      { npcId: 'npc:walker', role: 'pitcher', claims: ['同源神药'], amountGcc: 1, room: '余杭集市', route: ['余杭集市', '余杭民居'], dwell: 1 },
      { npcId: faraway, role: 'townsfolk' }
    ]);
    const s0 = await spatial.runTick(0, 9000);   // tick0: pitcher at 集市, mark in 民居 → nothing
    assert.equal(s0.pitches.length, 0, 'cross-room pitch is impossible (no telepathy)');
    const s1 = await spatial.runTick(1, 9001);   // tick1: route moves the pitcher to 民居... (no record → stays)
    assert.equal(s1.moves.length, 0, 'a record-less pitcher cannot actually move');
    assert.equal(s1.pitches.length, 0, 'still out of reach');
    // give the walker a real record → the route carries him to the mark
    const walker = await world.createNpc({ id: 'npc:walker2', name: '货郎', owner: 'host:pal', background: '行商', room: '余杭集市', startGcc: 1 });
    const spatial2 = new FairTick(world, [
      { npcId: walker, role: 'pitcher', claims: ['同源神药'], amountGcc: 1, route: ['余杭集市', '余杭民居'], dwell: 1 },
      { npcId: faraway, role: 'townsfolk' }
    ]);
    const w0 = await spatial2.runTick(0, 9100);
    assert.equal(w0.pitches.length, 0, 'tick0: at 集市, mark unreachable');
    const w1 = await spatial2.runTick(1, 9101);
    assert.equal(w1.moves.length, 1, 'tick1: the route moves him to 民居');
    assert.equal(w1.moves[0].to, '余杭民居');
    assert.equal(w1.pitches.length, 1, 'co-located now → the pitch lands');
    assert.equal(w1.pitches[0].room, '余杭民居', 'the event carries its place');
    console.log('  ✓ SPATIAL: no telepathy — the route must carry the pitcher to the mark');

    console.log('\nFAIR-TICK SMOKE PASSED ✅');
  } finally {
    (globalThis as any).fetch = realFetch;
  }
}

main().catch((e) => { console.error('FAIR-TICK SMOKE FAILED ❌', e); process.exit(1); });
