/** Smoke for AiggMemoryKernel — wire-shape correctness via an injected fetch (no server).
 *  Run: pnpm --filter @aigg/cognition test:aigg */
import assert from 'node:assert/strict';
import { AiggMemoryKernel } from '../kernel/aigg';

type Captured = { url: string; body: any };

function fakeFetch(capture: Captured[], data: unknown) {
  return (async (url: string, init: any) => {
    capture.push({ url, body: JSON.parse(init.body) });
    return { json: async () => ({ ok: true, data }) } as any;
  }) as unknown as typeof fetch;
}

async function main() {
  // remember: fields must be INSIDE payload, never body-level
  let cap: Captured[] = [];
  let k = new AiggMemoryKernel({ baseUrl: 'http://x', fetchImpl: fakeFetch(cap, {}) });
  await k.remember('npcs/a/memory', { slug: 'b', description: 'd', match: ['elixir', 'trap'], kind: 'belief', assertedBy: 'a', outcome: 'loss' });
  const rb = cap[0].body;
  assert.equal(cap[0].url, 'http://x/memory/remember', 'remember endpoint');
  assert.equal(rb.outcome, undefined, 'outcome is NOT body-level (would make the kernel skip the record)');
  assert.equal(rb.payload.outcome, 'loss', 'outcome lives inside payload');
  assert.equal(rb.payload.kind, 'belief', 'kind inside payload');
  assert.equal(rb.payload.asserted_by, 'a', 'asserted_by (snake_case) inside payload');
  assert.deepEqual(rb.payload.match, ['elixir', 'trap'], 'match inside payload');

  // discernment: defaults to mode:'text' (NOT provenance)
  cap = [];
  k = new AiggMemoryKernel({ baseUrl: 'http://x', fetchImpl: fakeFetch(cap, { q: 1, faculty: 1, social: 0, confidence: 0.5 }) });
  const d = await k.discernment('npcs/a/memory', 'elixir', { selfId: 'a' });
  assert.equal(cap[0].body.mode, 'text', 'discernment defaults to text mode');
  assert.equal(cap[0].body.self_id, 'a', 'self_id passed snake_case');
  assert.equal(d.q, 1, 'parses the discernment envelope');

  // select: maps unit.path → slug
  cap = [];
  k = new AiggMemoryKernel({ baseUrl: 'http://x', fetchImpl: fakeFetch(cap, { units: [{ path: 'p1', description: 'd1', kind: 'belief' }], bundle: 'B', total_in_corpus: 3 }) });
  const sel = await k.select('npcs/a/memory', 'elixir');
  assert.equal(sel.units[0].slug, 'p1', 'path mapped to slug');
  assert.equal(sel.total, 3, 'total mapped');

  // reflect throws without a configured backend
  k = new AiggMemoryKernel({ baseUrl: 'http://x', fetchImpl: fakeFetch([], {}) });
  await assert.rejects(() => k.reflect('npcs/a/memory'), /no LLM backend/, 'reflect requires a backend');

  // non-ok envelope throws
  const errFetch = (async () => ({ json: async () => ({ ok: false, diagnostics: [{ code: 'E', message: 'bad' }] }) } as any)) as unknown as typeof fetch;
  k = new AiggMemoryKernel({ baseUrl: 'http://x', fetchImpl: errFetch });
  await assert.rejects(() => k.discernment('npcs/a/memory', 'x'), /bad/, 'non-ok envelope throws');

  console.log('ALL AIGG SMOKE TESTS PASSED ✅');
}
main().catch((e) => { console.error('AIGG SMOKE FAILED ❌', e); process.exit(1); });
