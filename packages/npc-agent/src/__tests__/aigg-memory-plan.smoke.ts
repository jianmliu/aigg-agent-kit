/**
 * aigg-memory-plan smoke — AiggMemoryClient.plan() posts the right body to
 * /memory/plan (the planning faculty over HTTP). Fakes fetch (no server).
 *
 * Run: tsx src/__tests__/aigg-memory-plan.smoke.ts
 */
import assert from 'node:assert/strict';
import { AiggMemoryClient } from '../index';

async function main() {
  let captured: { url: string; body: any } | null = null;
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    captured = { url, body: JSON.parse(init.body) };
    return { ok: true, status: 200, json: async () => ({ ok: true, data: { plans: [{ slug: 'help-traveler', name: '帮旅人', description: '明天备好退烧药' }], written: true } }) } as any;
  };
  try {
    const c = new AiggMemoryClient({ baseUrl: 'http://localhost:8788', defaultCorpus: 'npcs/鸿蒙/memory' });
    const res = await c.plan({ now: '2026-06-09T08:00', goals: ['帮助生病旅人'], write: true, aiggUrl: 'http://localhost:11434/v1', aiggKey: 'ollama', model: 'gemma4:latest', backend: 'http' });

    assert.ok(captured.url.endsWith('/memory/plan'), 'POST /memory/plan');
    assert.equal(captured.body.corpus, 'npcs/鸿蒙/memory', 'default corpus');
    assert.equal(captured.body.now, '2026-06-09T08:00', 'now required (kernel has no clock)');
    assert.deepEqual(captured.body.goals, ['帮助生病旅人']);
    assert.equal(captured.body.write, true);
    assert.equal(captured.body.aigg_url, 'http://localhost:11434/v1', 'model backend passed (ollama)');
    assert.equal(captured.body.backend, 'http');
    assert.equal(captured.body.model, 'gemma4:latest');
    assert.equal(res.plans[0].name, '帮旅人', 'parses PlanResult');
    console.log('  ✓ plan() → POST /memory/plan with corpus/now/goals/write + model backend; parses PlanResult');

    // remember() — the zero-LLM structured-fact write path (the MUD's recall source)
    captured = null;
    (globalThis as any).fetch = async (url: string, init: any) => { captured = { url, body: JSON.parse(init.body) }; return { ok: true, status: 200, json: async () => ({ ok: true, data: { ok: true } }) } as any; };
    await c.remember({ name: '旅人很有礼貌', kind: 'semantic', description: '旅人多次道谢', match: ['旅人', '礼貌'] }, { evidence: 'npcs/鸿蒙/evidence.jsonl' });
    assert.ok(captured.url.endsWith('/memory/remember'), 'POST /memory/remember');
    assert.equal(captured.body.payload.name, '旅人很有礼貌');
    assert.deepEqual(captured.body.payload.match, ['旅人', '礼貌']);
    assert.equal(captured.body.evidence, 'npcs/鸿蒙/evidence.jsonl');
    console.log('  ✓ remember() → POST /memory/remember with payload(name/kind/description/match) — zero-LLM fact write');

    // ingest() — the gemma4-tolerant raw-dialogue extraction path
    captured = null;
    (globalThis as any).fetch = async (url: string, init: any) => { captured = { url, body: JSON.parse(init.body) }; return { ok: true, status: 200, json: async () => ({ ok: true, data: { ok: true } }) } as any; };
    await c.ingest('旅人说他妹妹生病了', { aiggUrl: 'http://localhost:11434/v1', model: 'gemma4:latest', backend: 'http' });
    assert.ok(captured.url.endsWith('/memory/ingest'), 'POST /memory/ingest');
    assert.equal(captured.body.text, '旅人说他妹妹生病了');
    assert.equal(captured.body.aigg_url, 'http://localhost:11434/v1', 'ingest passes the model backend');
    console.log('  ✓ ingest() → POST /memory/ingest with text + model backend — raw-dialogue extraction');
  } finally {
    (globalThis as any).fetch = realFetch;
  }
  console.log('\nAIGG-MEMORY-PLAN SMOKE PASSED ✅');
}

main().catch((e) => { console.error('AIGG-MEMORY-PLAN SMOKE FAILED ❌', e); process.exit(1); });
