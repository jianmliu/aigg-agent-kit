/**
 * plan-executor smoke — the plan→room execution loop, offline (no LLM):
 *   1. a step naming a PERSON targets their CURRENT room — the executor walks
 *      one BFS hop per tick (镇内→集市→药铺), then TALKS on arrival;
 *   2. place-alias steps walk to the room; person-less arrival completes;
 *   3. unresolvable wording skips (model phrasing can never wedge it);
 *   4. unreachable rooms skip; queue exhaustion idles;
 *   5. planSteps(): kind=plan units feed the queue, stale ones excluded
 *      (the deterministic re-plan trigger).
 *
 * Run: npx tsx src/__tests__/plan-executor.smoke.ts
 */
import assert from 'node:assert/strict';
import { SharedWorld } from '../shared-world';
import { PlanExecutor, nextHop } from '../plan-executor';
import { InMemoryStore, AiggMemoryClient, Metabolism, type InferenceProvider, type InferenceResult } from '@onchainpal/npc-agent';

class Scripted implements InferenceProvider {
  readonly id = 'scripted';
  async complete(): Promise<InferenceResult> {
    return {
      text: JSON.stringify({ say: '老朽看看……此乃多年痼疾,须徐徐图之。', effects: [], emotion: '平和' }),
      usage: { model: 's', inputTokens: 1, outputTokens: 1, gccCost: 0 }
    };
  }
}

/** emits a `goto` effect — models the NPC being told「去药铺」by the player. */
class GotoProvider implements InferenceProvider {
  readonly id = 'goto';
  async complete(): Promise<InferenceResult> {
    return {
      text: JSON.stringify({ say: '好，我这就去。', effects: [{ kind: 'goto', place: '药铺' }], emotion: '' }),
      usage: { model: 'g', inputTokens: 1, outputTokens: 1, gccCost: 0 }
    };
  }
}

/** fake aigg-memory: serves plan units (one stale) for planSteps(). */
function fakeMemory(): AiggMemoryClient {
  const client = new AiggMemoryClient({ baseUrl: 'http://fake' });
  (globalThis as any).fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    const data = path === '/memory/units' ? { total: 3, units: [
      { path: 'npcs/x/memory/plan_02_market/SKILL.md', name: 'plan_02_market', kind: 'plan', status: 'candidate', description: '去集市找张四打听镇上的传闻', observations: 0, confidence: 'medium', match_terms: [] },
      { path: 'npcs/x/memory/plan_01_doctor/SKILL.md', name: 'plan_01_doctor', kind: 'plan', status: 'candidate', description: '去药铺请洪大夫给爹看看老毛病', observations: 0, confidence: 'medium', match_terms: [] },
      { path: 'npcs/x/memory/plan_00_dead/SKILL.md', name: 'plan_00_dead', kind: 'plan', status: 'stale', description: '已作废的旧打算', observations: 0, confidence: 'low', match_terms: [] }
    ] } : { ok: true };
    return { ok: true, status: 200, json: async () => ({ ok: true, diagnostics: [], data }) } as any;
  }) as unknown as typeof fetch;
  return client;
}

const GRAPH = { '镇内': ['集市', '药铺', '民居'], '集市': ['镇内'], '药铺': ['镇内'], '民居': ['镇内'] };
const ALIASES = { '集市': ['集市', '菜市场'], '药铺': ['药铺', '药店'], '民居': ['民居', '丁家'] };

async function main() {
  const realFetch = globalThis.fetch;
  try {
    // nextHop sanity
    assert.equal(nextHop(GRAPH, '集市', '药铺'), '镇内', 'BFS routes through the hub');
    assert.equal(nextHop(GRAPH, '镇内', '镇内'), null);
    assert.equal(nextHop(GRAPH, '集市', '荒山'), null, 'unknown rooms unreachable');

    const rich = new Metabolism({ tiers: [{ id: 'r', minBalanceGcc: 0, model: 'm', label: '充盈' }], starvingBelowGcc: -1, defaultTierId: 'r' });
    const world = new SharedWorld({ store: new InMemoryStore(), provider: new Scripted(), metabolism: rich, rooms: Object.keys(GRAPH) });
    const xianglan = await world.createNpc({ name: '香兰', owner: 'host:pal', background: '丁家长女', room: '集市', startGcc: 2 });
    await world.createNpc({ name: '洪大夫', owner: 'host:pal', background: '药铺大夫', room: '药铺', startGcc: 2 });
    await world.createNpc({ name: '张四', owner: 'host:pal', background: '渔夫', room: '集市', startGcc: 2 });

    // 1. person step: walk hop by hop to HIS room, then talk
    const ex = new PlanExecutor(world, {
      npcId: xianglan, roomGraph: GRAPH, roomAliases: ALIASES,
      steps: ['请洪大夫给爹看看老毛病', '去菜市场看看有没有新鲜鱼', '念叨些没人听得懂的胡话', '去蓬莱仙岛求仙']
    });
    let a = await ex.runTick();
    assert.deepEqual({ kind: a.kind, to: (a as any).to }, { kind: 'move', to: '镇内' }, 'hop 1 toward the doctor');
    a = await ex.runTick();
    assert.deepEqual({ kind: a.kind, to: (a as any).to }, { kind: 'move', to: '药铺' }, 'hop 2 arrives at the apothecary');
    a = await ex.runTick();
    assert.equal(a.kind, 'talk');
    assert.equal((a as any).targetName, '洪大夫', 'talks to the person the step names');
    assert.ok((a as any).said?.includes('痼疾'), 'the NPC↔NPC reply came back');
    console.log('  ✓ person step: 找到对方 — BFS hops to their room, then talks');

    // 2. place-alias step: walk to the market, arrive (no person)
    a = await ex.runTick();           // 药铺 → 镇内
    assert.equal(a.kind, 'move');
    a = await ex.runTick();           // 镇内 → 集市
    assert.equal((a as any).to, '集市');
    a = await ex.runTick();
    assert.equal(a.kind, 'talk', 'arrived with intent → asks whoever is here');
    assert.equal((a as any).targetName, '张四', 'ask-around picks the co-located NPC');
    console.log('  ✓ place step: walks there and ASKS AROUND (vague plans end in conversation)');

    // 3. unresolvable + unreachable both skip; then idle
    a = await ex.runTick();
    assert.deepEqual({ kind: a.kind, reason: (a as any).reason }, { kind: 'skip', reason: 'unresolved' }, 'gibberish skips');
    a = await ex.runTick();
    assert.deepEqual({ kind: a.kind, reason: (a as any).reason }, { kind: 'skip', reason: 'unresolved' }, '蓬莱 matches no table');
    a = await ex.runTick();
    assert.equal(a.kind, 'idle', 'queue exhausted');
    console.log('  ✓ unresolvable wording skips; exhaustion idles — the model can never wedge it');

    // 4. planSteps(): plan units feed the queue, stale excluded, slug-ordered
    const world2 = new SharedWorld({ store: new InMemoryStore(), provider: new Scripted(), metabolism: rich, memory: fakeMemory(), rooms: Object.keys(GRAPH) });
    const x2 = await world2.createNpc({ name: '香兰', owner: 'host:pal', background: '丁家长女', room: '镇内', startGcc: 2 });
    const steps = await world2.planSteps(x2);
    assert.deepEqual(steps.map((s) => s.slug), ['plan_01_doctor', 'plan_02_market'], 'stale plan excluded; slug order');
    const ex2 = new PlanExecutor(world2, { npcId: x2, roomGraph: GRAPH, roomAliases: ALIASES });
    a = await ex2.runTick();
    assert.deepEqual({ kind: a.kind, to: (a as any).to }, { kind: 'move', to: '药铺' }, 'memory-fed queue drives the walk');
    console.log('  ✓ planSteps: kind=plan units feed the queue; stale = the deterministic re-plan trigger');

    // 5. goto 算子: a talk that emits goto → inbox → executor walks there, preempting
    const world3 = new SharedWorld({ store: new InMemoryStore(), provider: new GotoProvider(), metabolism: rich, rooms: Object.keys(GRAPH) });
    const lan = await world3.createNpc({ name: '香兰', owner: 'host:pal', background: '丁家长女', room: '集市', startGcc: 2 });
    const ex3 = new PlanExecutor(world3, { npcId: lan, roomGraph: GRAPH, roomAliases: ALIASES });

    // idle until told
    assert.equal((await ex3.runTick()).kind, 'idle', 'no plan, no directive → idle');
    // the player tells her「去药铺」— talk emits the goto effect → pushGoto
    await world3.talk({ npcId: lan, visitorId: 'player:你', text: '去药铺' });
    assert.deepEqual(world3.takeGoto(lan), ['药铺'], 'talk routed the goto effect into the inbox');
    // (re-arm it since takeGoto above drained it for the assertion)
    world3.pushGoto(lan, '药铺');
    a = await ex3.runTick();
    assert.deepEqual({ kind: a.kind, to: (a as any).to }, { kind: 'move', to: '镇内' }, 'goto walks one hop toward 药铺');
    a = await ex3.runTick();
    assert.deepEqual({ kind: a.kind, to: (a as any).to }, { kind: 'move', to: '药铺' }, 'second hop arrives');

    // preemption: mid-nothing, a fresh goto leads even over a standing queued step
    const ex4 = new PlanExecutor(world3, { npcId: lan, roomGraph: GRAPH, roomAliases: ALIASES, steps: ['去菜市场看看'] });
    world3.pushGoto(lan, '民居');             // 香兰 is now at 药铺
    a = await ex4.runTick();
    assert.deepEqual({ kind: a.kind, to: (a as any).to }, { kind: 'move', to: '镇内' }, 'fresh goto preempts the standing step');
    console.log('  ✓ goto 算子: talk→inbox→executor walks there, preempting standing plans');

    console.log('\nPLAN-EXECUTOR SMOKE PASSED ✅');
  } finally {
    (globalThis as any).fetch = realFetch;
  }
}

main().catch((e) => { console.error('PLAN-EXECUTOR SMOKE FAILED ❌', e); process.exit(1); });
