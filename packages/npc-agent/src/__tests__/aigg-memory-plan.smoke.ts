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
  } finally {
    (globalThis as any).fetch = realFetch;
  }
  console.log('\nAIGG-MEMORY-PLAN SMOKE PASSED ✅');
}

main().catch((e) => { console.error('AIGG-MEMORY-PLAN SMOKE FAILED ❌', e); process.exit(1); });
