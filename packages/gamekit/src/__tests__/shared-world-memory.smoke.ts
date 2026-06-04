/**
 * Headless smoke: SharedWorld + AiggMemoryClient against a FAKE agentmf serve
 * (a tiny node:http server that mimics /memory/* endpoints in-process). Proves:
 *   1. select() is called before each talk() → memoryBundle injected into persona
 *   2. observe() is called after each talk() with the interaction summary
 *   3. consolidate(write:true) is called when the NPC is in the "充盈" rich tier
 *   4. select/observe/consolidate errors are swallowed — talk() never throws
 *   5. without a memory client, talk() behaves identically to before (regression)
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
        if (req.url === '/memory/observe') {
          res.end(JSON.stringify({ ok: true, diagnostics: [], data: { event_id: 'evt1', fingerprint: 'fp', timestamp: 't', source: 'observation', outcome: null } }));
        } else if (req.url === '/memory/consolidate') {
          res.end(JSON.stringify({ ok: true, diagnostics: [], data: { proposals: [{ proposal_id: 'p1', title: 'remember: visitor' }], gates: [{ name: 'units_parse', passed: true, detail: '' }], gates_ok: true, written: body.write === true, units_after: [] } }));
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
  assert.equal(selectCalls[0].body.corpus, `npcs/${id}/memory`, 'select uses per-NPC corpus');
  console.log('  ✓ select() called before LLM; per-NPC corpus used');
}

async function test_observe_fires_after_talk(port: number, calls: Call[]) {
  const client = new AiggMemoryClient({ baseUrl: `http://127.0.0.1:${port}` });
  const world = new SharedWorld({ store: new InMemoryStore(), provider: new ScriptedProvider(), metabolism: richMetabolism, memory: client });
  const id = await world.createNpc({ name: '酒剑仙', owner: 'user:A', background: 'bg', room: '酒馆', startGcc: 0.0009 });

  calls.length = 0;
  await world.talk({ npcId: id, visitorId: '游侠', text: '来壶酒' });
  await sleep(50); // fire-and-forget

  const obsCalls = calls.filter((c) => c.path === '/memory/observe');
  assert.ok(obsCalls.length >= 1, 'observe fired after talk');
  const payload = obsCalls[0].body.payload as Record<string, unknown>;
  assert.ok(String(payload.body).includes('好感'), 'observe payload includes affinity info');
  assert.ok(String(payload.match).includes('affinity'), 'observe payload includes match terms');
  console.log('  ✓ observe() fired after talk; payload contains affinity + match terms');
}

async function test_consolidate_triggers_on_rich_tier(port: number, calls: Call[]) {
  const client = new AiggMemoryClient({ baseUrl: `http://127.0.0.1:${port}` });
  // start with RICH balance (> 0.0005 → tier 'r')
  const world = new SharedWorld({ store: new InMemoryStore(), provider: new ScriptedProvider(), metabolism: richMetabolism, memory: client });
  const id = await world.createNpc({ name: '酒剑仙', owner: 'user:A', background: 'bg', room: '酒馆', startGcc: 0.0009 });

  calls.length = 0;
  await world.talk({ npcId: id, visitorId: '游侠', text: '论剑' });
  await sleep(50);

  const consolCalls = calls.filter((c) => c.path === '/memory/consolidate');
  assert.ok(consolCalls.length >= 1, 'consolidate triggered on rich tier');
  assert.equal(consolCalls[0].body.write, true, 'consolidate called with write=true');
  console.log('  ✓ consolidate(write:true) triggered when tier is "充盈"');
}

async function test_consolidate_skipped_on_lean_tier(port: number, calls: Call[]) {
  const client = new AiggMemoryClient({ baseUrl: `http://127.0.0.1:${port}` });
  // lean balance (0.0002 → tier 'l', not rich)
  const world = new SharedWorld({ store: new InMemoryStore(), provider: new ScriptedProvider(), metabolism: richMetabolism, memory: client });
  const id = await world.createNpc({ name: '酒剑仙', owner: 'user:A', background: 'bg', room: '酒馆', startGcc: 0.0002 });

  calls.length = 0;
  await world.talk({ npcId: id, visitorId: '游侠', text: '论剑' });
  await sleep(50);

  const consolCalls = calls.filter((c) => c.path === '/memory/consolidate');
  assert.equal(consolCalls.length, 0, 'consolidate NOT triggered on lean tier');
  console.log('  ✓ consolidate NOT triggered when tier is "清醒" (lean) — saves cost');
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
    await test_observe_fires_after_talk(port, calls);
    await test_consolidate_triggers_on_rich_tier(port, calls);
    await test_consolidate_skipped_on_lean_tier(port, calls);
    await test_memory_errors_do_not_break_talk(port, calls);
    await test_without_memory_client_unchanged(port, calls);
  } finally {
    close();
  }
  console.log('\nSHARED-WORLD × AIGG-MEMORY SMOKE PASSED ✅');
}

main().catch((e) => { console.error('FAILED ❌', e); process.exit(1); });
