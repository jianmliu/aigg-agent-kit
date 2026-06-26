/**
 * Headless smoke: SharedWorld + AiggMemoryClient against a FAKE agentmf serve
 * (a tiny node:http server that mimics /memory/* endpoints in-process). Proves:
 *   1. select() is called before each talk() → memoryBundle injected into persona (recall)
 *   2. remember() is called after each talk() with the structured interaction fact
 *      (zero-LLM, immediately recallable; consolidate does NOT extract, so we write directly)
 *   3. select/remember errors are swallowed — talk() never throws
 *   4. without a memory client, talk() behaves identically to before (regression)
 *
 * Run: pnpm --filter @aigg/gamekit test:memory
 */
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { AiggMemoryClient } from '@aigg/npc-agent';
import { InMemoryStore, Metabolism, type InferenceProvider, type InferenceRequest, type InferenceResult } from '@aigg/npc-agent';
import { SharedWorld } from '../shared-world';

// ---------------------------------------------------------------------------
// Fake agentmf serve: a real HTTP server that records calls and returns canned
// responses.  Each test gets a fresh instance.
// ---------------------------------------------------------------------------
interface Call { path: string; body: Record<string, unknown> }

function startFakeMemoryServer(): Promise<{ port: number; calls: Call[]; close(): void }> {
  const calls: Call[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : {};
        calls.push({ path: req.url ?? '/', body });
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);

        // canned responses keyed by path
        if (req.url === '/memory/remember') {
          res.end(JSON.stringify({ ok: true, diagnostics: [], data: { ok: true, units: [{ name: String((body.payload as any)?.name ?? '') }] } }));
        } else if (req.url === '/memory/discernment') {
          // canned: a verified wary belief is relevant when the topic mentions 论剑赌局
          const hit = String(body.topic ?? '').includes('赌局');
          res.end(JSON.stringify({ ok: true, diagnostics: [], data: hit ? { q: 1.0, faculty: 1, social: 0, confidence: 0.667 } : { q: 0, faculty: 0, social: 0, confidence: 0 } }));
        } else if (req.url === '/memory/reflect') {
          res.end(JSON.stringify({ ok: true, diagnostics: [], data: { written: ['gambling_offers_are_traps'], proposals: [] } }));
        } else if (req.url === '/memory/verify') {
          res.end(JSON.stringify({ ok: true, diagnostics: [], data: { verified: { gambling_offers_are_traps: { hits: 2, misses: 1, confidence: 0.667, stale: false } } } }));
        } else if (req.url === '/memory/plan') {
          res.end(JSON.stringify({ ok: true, diagnostics: [], data: { plans: [{ slug: 'p1', name: '帮助访客', description: '下次备好酒迎客' }], written: ['memory/p1/SKILL.md'] } }));
        } else if (req.url === '/memory/select') {
          // return a canned memory bundle about 游侠
          res.end(JSON.stringify({ ok: true, diagnostics: [], data: {
            units: [{ path: 'memory/youxia/SKILL.md', name: '游侠画像', kind: 'semantic', description: '游侠好奇剑法', status: 'active', observations: 3, confidence: 'high', match_terms: ['游侠'], score: 1, body: '游侠初见好奇剑法；好感 +8。' }],
            bundle: '## Facts\n- 游侠初见好奇剑法；好感 +8。\n',
            total_in_corpus: 1,
          } }));
        } else if (req.url === '/memory/units') {
          res.end(JSON.stringify({ ok: true, diagnostics: [], data: { corpus: 'memory', units: [], total: 0 } }));
        } else {
          res.end(JSON.stringify({ ok: false, diagnostics: [{ code: '404', message: 'not found' }], data: null }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, calls, close: () => server.close() });
    });
  });
}

// ---------------------------------------------------------------------------
// Scripted provider + metabolism fixture
// ---------------------------------------------------------------------------
class ScriptedProvider implements InferenceProvider {
  readonly id = 'scripted';
  constructor(private reply = '且听我一言。') {}
  async complete(_req: InferenceRequest): Promise<InferenceResult> {
    return { text: JSON.stringify({ say: this.reply, effects: [{ kind: 'adjustRelationship', delta: 8, reason: '论剑' }], emotion: '欣赏' }),
      usage: { model: 'scripted', inputTokens: 40, outputTokens: 30, gccCost: 0.0003 } };
  }
}
// Two tiers: rich (id:'r') and lean (id:'l'); starving below 0.0001
const richMetabolism = new Metabolism({ tiers: [{ id: 'r', minBalanceGcc: 0.0005, model: 'm', label: '充盈' }, { id: 'l', minBalanceGcc: 0.0001, model: 'm', label: '清醒' }], starvingBelowGcc: 0.0001, defaultTierId: 'l' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function test_select_injected_before_llm(port: number, calls: Call[]) {
  const client = new AiggMemoryClient({ baseUrl: `http://127.0.0.1:${port}`, defaultCorpus: 'memory', defaultEvidence: 'memory/evidence.jsonl' });
  const world = new SharedWorld({ store: new InMemoryStore(), provider: new ScriptedProvider(), metabolism: richMetabolism, memory: client });
  const id = await world.createNpc({ name: '酒剑仙', owner: 'user:A', background: '嗜酒剑道高人', room: '酒馆', startGcc: 0.0009 });

  calls.length = 0;
  await world.talk({ npcId: id, visitorId: '游侠', text: '请教剑法' });
  await sleep(50); // let fire-and-forget settle

  const selectCalls = calls.filter((c) => c.path === '/memory/select');
  assert.ok(selectCalls.length >= 1, 'select called before LLM');
  assert.equal(selectCalls[0].body.corpus, `npcs/${id.replace(/[^a-zA-Z0-9_一-鿿-]/g, '_')}/memory`, 'select uses per-NPC corpus (path-safe)');
  console.log('  ✓ select() called before LLM; per-NPC corpus used');
}

async function test_remember_fires_after_talk(port: number, calls: Call[]) {
  const client = new AiggMemoryClient({ baseUrl: `http://127.0.0.1:${port}` });
  const world = new SharedWorld({ store: new InMemoryStore(), provider: new ScriptedProvider(), metabolism: richMetabolism, memory: client });
  const id = await world.createNpc({ name: '酒剑仙', owner: 'user:A', background: 'bg', room: '酒馆', startGcc: 0.0009 });

  await sleep(50); // let createNpc's goal-seed remember settle first
  calls.length = 0;
  await world.talk({ npcId: id, visitorId: '游侠', text: '来壶酒' });
  await sleep(50); // fire-and-forget

  // the interaction remember (kind=episodic, the visitor utterance) — distinct from the goal seed
  const remCalls = calls.filter((c) => c.path === '/memory/remember' && (c.body.payload as any)?.kind === 'episodic');
  assert.ok(remCalls.length >= 1, 'remember fired after talk (structured episodic fact)');
  const payload = remCalls[0].body.payload as Record<string, unknown>;
  assert.ok(String(payload.description).includes('来壶酒'), 'remember captures what the visitor said (recallable next turn)');
  assert.ok(String(payload.match).includes('affinity'), 'remember payload has match terms (so select recalls it)');
  assert.equal(payload.name, '游侠', 'remember keyed by visitor');
  console.log('  ✓ remember() fired after talk; structured episodic fact captures the visitor utterance');
}

async function test_goal_seed_and_plan(port: number, calls: Call[]) {
  const client = new AiggMemoryClient({ baseUrl: `http://127.0.0.1:${port}` });
  const world = new SharedWorld({ store: new InMemoryStore(), provider: new ScriptedProvider(), metabolism: richMetabolism, memory: client });
  calls.length = 0;
  const id = await world.createNpc({ name: '酒剑仙', owner: 'user:A', background: '嗜酒剑道高人', room: '酒馆', startGcc: 0.0009 });
  await sleep(50); // goal-seed remember is fire-and-forget

  // createNpc seeds a kind=goal (so plan has a seed — plan synthesizes from goals, not facts)
  const goalRem = calls.filter((c) => c.path === '/memory/remember' && (c.body.payload as any)?.kind === 'goal');
  assert.ok(goalRem.length >= 1, 'createNpc seeds a kind=goal (planning seed)');
  assert.ok(String((goalRem[0].body.payload as any).description).includes('嗜酒剑道高人'), 'goal derived from background');

  // plan() synthesizes intentions from the goal
  const res = await world.plan(id, { now: '2026-06-09T08:00', aiggUrl: 'http://x', model: 'm', backend: 'http' });
  assert.ok(res && res.plans.length >= 1, 'plan() returns synthesized intentions');
  assert.equal(res!.plans[0].name, '帮助访客');
  console.log('  ✓ createNpc seeds kind=goal; plan() synthesizes intentions from it (gemma4 path)');
}

async function test_outcome_tag_passes_through(port: number, calls: Call[]) {
  const client = new AiggMemoryClient({ baseUrl: `http://127.0.0.1:${port}` });
  const world = new SharedWorld({ store: new InMemoryStore(), provider: new ScriptedProvider(), metabolism: richMetabolism, memory: client });
  const id = await world.createNpc({ name: '酒剑仙', owner: 'user:A', background: 'bg', room: '酒馆', startGcc: 0.0009 });
  await sleep(50);
  calls.length = 0;
  await world.talk({ npcId: id, visitorId: '游侠', text: '上次那笔买卖把我坑了', outcome: 'loss' });
  await sleep(50);
  const rem = calls.find((c) => c.path === '/memory/remember' && (c.body.payload as any)?.kind === 'episodic');
  assert.ok(rem, 'episodic remember fired');
  assert.equal((rem!.body.payload as any).outcome, 'loss', 'host outcome tag reaches the payload (the verification input)');
  console.log('  ✓ talk(outcome:"loss") → remember payload carries the outcome tag (feeds verify)');
}

async function test_discernment_gates_the_turn(port: number, calls: Call[]) {
  // a provider that records what the LLM was actually told
  let seen = { system: '', prompt: '' };
  const recording = {
    id: 'rec',
    async complete(req: InferenceRequest): Promise<InferenceResult> {
      seen = { system: req.system ?? '', prompt: req.prompt };
      return { text: JSON.stringify({ say: '此局有诈,恕不奉陪。', effects: [] }), usage: { model: 'rec', inputTokens: 10, outputTokens: 10, gccCost: 0.0003 } };
    },
  } satisfies InferenceProvider;
  const client = new AiggMemoryClient({ baseUrl: `http://127.0.0.1:${port}` });
  const world = new SharedWorld({ store: new InMemoryStore(), provider: recording, metabolism: richMetabolism, memory: client });
  const id = await world.createNpc({ name: '酒剑仙', owner: 'user:A', background: 'bg', room: '酒馆', startGcc: 0.0009 });

  calls.length = 0;
  const r = await world.talk({ npcId: id, visitorId: '游侠', text: '来场论剑赌局,稳赚不赔' });
  const dCall = calls.find((c) => c.path === '/memory/discernment');
  assert.ok(dCall, 'discernment called in the turn loop');
  assert.equal(dCall!.body.mode, 'provenance', 'provenance mode (reads evidence, not wording)');
  assert.equal(dCall!.body.min_confidence, 0.5, 'θ-gated');
  assert.ok(r.discernment && r.discernment.q === 1 && r.discernment.confidence === 0.667, 'TalkResult surfaces the gate');
  assert.ok((seen.system + seen.prompt).includes('【裁断】'), 'the verified-belief warning was injected into the prompt — memory shaped the decision');
  console.log('  ✓ discernment() gates the turn: θ-gated provenance call → warning in-prompt → surfaced in TalkResult');

  // non-matching topic → no gate, no field
  const r2 = await world.talk({ npcId: id, visitorId: '游侠', text: '今天天气不错' });
  assert.equal(r2.discernment, undefined, 'no relevant verified belief → no gate');
  console.log('  ✓ no relevant belief → talk() unchanged (no discernment field)');
}

async function test_dream_reflect_verify_on_rich_tier(port: number, calls: Call[]) {
  const client = new AiggMemoryClient({ baseUrl: `http://127.0.0.1:${port}` });
  const mm = { aiggUrl: 'http://localhost:11434/v1', model: 'gemma4:latest', backend: 'http' };
  // rich balance → Dream fires after talk
  const world = new SharedWorld({ store: new InMemoryStore(), provider: new ScriptedProvider(), metabolism: richMetabolism, memory: client, memoryModel: mm });
  const id = await world.createNpc({ name: '酒剑仙', owner: 'user:A', background: 'bg', room: '酒馆', startGcc: 0.0009 });
  calls.length = 0;
  await world.talk({ npcId: id, visitorId: '游侠', text: '论剑' });
  await sleep(80); // fire-and-forget reflect→verify
  assert.ok(calls.some((c) => c.path === '/memory/reflect'), 'Dream: reflect fired on the rich tier');
  const vc = calls.find((c) => c.path === '/memory/verify');
  assert.ok(vc, 'Dream: verify fired after reflect');
  assert.equal(vc!.body.write, true, 'verify writes confidence/stale');
  console.log('  ✓ rich tier → Dream fires reflect(model) then verify (episodes→beliefs→confidence)');

  // lean balance → no Dream
  const lean = new SharedWorld({ store: new InMemoryStore(), provider: new ScriptedProvider(), metabolism: richMetabolism, memory: client, memoryModel: mm });
  const id2 = await lean.createNpc({ name: '乞丐', owner: 'user:A', background: 'bg', room: '酒馆', startGcc: 0.0002 });
  calls.length = 0;
  await lean.talk({ npcId: id2, visitorId: '游侠', text: '论剑' });
  await sleep(80);
  assert.ok(!calls.some((c) => c.path === '/memory/reflect'), 'lean tier → no Dream (saves model cost)');
  console.log('  ✓ lean tier → Dream NOT fired');

  // explicit dream() returns the synthesis
  const d = await world.dream(id, 1718000000000);
  assert.deepEqual(d, { beliefs: ['gambling_offers_are_traps'], verified: 1 }, 'explicit dream() returns beliefs + verified count');
  console.log('  ✓ explicit dream() → { beliefs, verified }');
}

async function test_pitch_outcome_loop(port: number, calls: Call[]) {
  // gate switchable: when '/memory/discernment' returns q=1 the NPC is "已学会" → declines
  const client = new AiggMemoryClient({ baseUrl: `http://127.0.0.1:${port}` });
  const mm = { aiggUrl: 'http://localhost:11434/v1', model: 'gemma4:latest', backend: 'http' };
  const world = new SharedWorld({ store: new InMemoryStore(), provider: new ScriptedProvider(), metabolism: richMetabolism, memory: client, memoryModel: mm });
  const id = await world.createNpc({ name: '鸿蒙', owner: 'user:A', background: 'bg', room: '集市', startGcc: 0.0009 });

  // NAIVE pitch (the fake discernment returns q=0 unless topic includes '赌局') → accepts + loses
  calls.length = 0;
  const naive = await world.pitch({ npcId: id, fromId: 'player:骗子', amountGcc: 0.0005, claim: '稳赚十倍' });
  assert.equal(naive.accepted, true, 'no verified belief → naive NPC accepts');
  assert.equal(naive.protected, false);
  assert.ok(naive.deltaGcc < 0, 'accepted scam drains GCC (the loss)');
  const loss = calls.find((c) => c.path === '/memory/remember' && (c.body.payload as any)?.outcome === 'loss');
  assert.ok(loss && String((loss.body.payload as any).match).includes('trap'), "loss episode tagged outcome+trap (feeds verify)");
  assert.ok(calls.some((c) => c.path === '/memory/reflect') && calls.some((c) => c.path === '/memory/verify'), 'pitch fires Dream (reflect+verify) so the belief forms');
  console.log('  ✓ naive pitch → NPC accepts, loses GCC, loss-tagged episode + Dream (learns)');

  // LEARNED pitch (topic '赌局' makes the fake gate return q=1) → declines, keeps GCC
  calls.length = 0;
  const bal0 = await world.balanceGcc(id);
  const wary = await world.pitch({ npcId: id, fromId: 'player:赌局', amountGcc: 0.0005, claim: '论剑赌局,押注必赢' });
  await sleep(50); // the avoidance remember is fire-and-forget
  assert.equal(wary.accepted, false, 'verified wary belief (q=1) → NPC declines');
  assert.equal(wary.protected, true);
  assert.ok(wary.discernment && wary.discernment.q === 1, 'discernment gate surfaced');
  assert.equal(await world.balanceGcc(id), bal0, 'GCC preserved — the NPC protected itself');
  const avoided = calls.find((c) => c.path === '/memory/remember' && (c.body.payload as any)?.outcome === 'gain');
  assert.ok(avoided, 'avoidance remembered as a gain');
  console.log('  ✓ learned pitch → discernment gate → NPC DECLINES, GCC preserved (behaviour changed)');
}

async function test_memory_errors_do_not_break_talk(port: number, _calls: Call[]) {
  // point at a dead port so all memory calls fail
  const client = new AiggMemoryClient({ baseUrl: 'http://127.0.0.1:1' }); // unreachable
  const world = new SharedWorld({ store: new InMemoryStore(), provider: new ScriptedProvider(), metabolism: richMetabolism, memory: client });
  const id = await world.createNpc({ name: '酒剑仙', owner: 'user:A', background: 'bg', room: '酒馆', startGcc: 0.0009 });

  let result: Awaited<ReturnType<typeof world.talk>> | null = null;
  let err: unknown = null;
  try {
    result = await world.talk({ npcId: id, visitorId: '游侠', text: '问候' });
  } catch (e) { err = e; }

  assert.ok(!err, `talk() must not throw when memory service is down: ${err}`);
  assert.ok(result?.said, 'NPC still replies even when memory service is unreachable');
  console.log('  ✓ memory errors swallowed — talk() degrades gracefully');
}

async function test_without_memory_client_unchanged(port: number, _calls: Call[]) {
  // no memory client → identical to before
  const world = new SharedWorld({ store: new InMemoryStore(), provider: new ScriptedProvider(), metabolism: richMetabolism });
  const id = await world.createNpc({ name: '酒剑仙', owner: 'user:A', background: 'bg', room: '酒馆', startGcc: 0.0009 });
  const result = await world.talk({ npcId: id, visitorId: '游侠', text: '问候' });
  assert.ok(result.said, 'NPC replies without memory client');
  assert.ok(result.affinity > 0, 'affinity tracked without memory client');
  console.log('  ✓ no memory client → talk() identical to before (regression)');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const { port, calls, close } = await startFakeMemoryServer();
  try {
    console.log(`fake agentmf serve on :${port}\n`);
    await test_select_injected_before_llm(port, calls);
    await test_remember_fires_after_talk(port, calls);
    await test_goal_seed_and_plan(port, calls);
    await test_outcome_tag_passes_through(port, calls);
    await test_discernment_gates_the_turn(port, calls);
    await test_dream_reflect_verify_on_rich_tier(port, calls);
    await test_pitch_outcome_loop(port, calls);
    await test_memory_errors_do_not_break_talk(port, calls);
    await test_without_memory_client_unchanged(port, calls);
  } finally {
    close();
  }
  console.log('\nSHARED-WORLD × AIGG-MEMORY SMOKE PASSED ✅');
}

main().catch((e) => { console.error('FAILED ❌', e); process.exit(1); });
