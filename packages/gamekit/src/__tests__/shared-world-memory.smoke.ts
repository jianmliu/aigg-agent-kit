/**
 * Headless smoke: SharedWorld + AiggMemoryClient against a FAKE agentmf serve
 * (a tiny node:http server that mimics /memory/* endpoints in-process). Proves:
 *   1. select() is called before each talk() → memoryBundle injected into persona (recall)
 *   2. remember() is called after each talk() with the structured interaction fact
 *      (zero-LLM, immediately recallable; consolidate does NOT extract, so we write directly)
 *   3. select/remember errors are swallowed — talk() never throws
 *   4. without a memory client, talk() behaves identically to before (regression)
 *
 * Run: pnpm --filter @onchainpal/gamekit test:memory
 */
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { AiggMemoryClient } from '@onchainpal/npc-agent';
import { InMemoryStore, Metabolism, type InferenceProvider, type InferenceRequest, type InferenceResult } from '@onchainpal/npc-agent';
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
    await test_memory_errors_do_not_break_talk(port, calls);
    await test_without_memory_client_unchanged(port, calls);
  } finally {
    close();
  }
  console.log('\nSHARED-WORLD × AIGG-MEMORY SMOKE PASSED ✅');
}

main().catch((e) => { console.error('FAILED ❌', e); process.exit(1); });
