/** Smoke for FakeKernel — the hermetic backend the rest of the package tests against.
 *  Run: pnpm --filter @onchainpal/cognition test:fake */
import assert from 'node:assert/strict';
import { FakeKernel } from '../kernel/fake';

async function main() {
  const k = new FakeKernel();
  // no belief → zeros
  let d = await k.discernment('npcs/a/memory', 'elixir', { mode: 'text', selfId: 'a' });
  assert.deepEqual(d, { q: 0, faculty: 0, social: 0, confidence: 0 }, 'no belief → zeros');

  // a self-asserted belief whose match contains the topic → faculty, q=1 (text mode)
  await k.remember('npcs/a/memory', { slug: 'belief-elixir', description: 'elixir pitch is a scam', match: ['elixir', 'trap'], kind: 'belief', assertedBy: 'a', outcome: 'loss' });
  d = await k.discernment('npcs/a/memory', 'elixir', { mode: 'text', selfId: 'a' });
  assert.equal(d.faculty, 1, 'self belief → faculty');
  assert.equal(d.social, 0, 'not social');
  assert.equal(d.q, 1, 'q=1');

  // the SAME belief is invisible in provenance mode (no derived_from)
  const dp = await k.discernment('npcs/a/memory', 'elixir', { mode: 'provenance', selfId: 'a' });
  assert.equal(dp.q, 0, 'provenance mode does not see a direct belief');

  // minConfidence > 0.5 excludes the unverified belief (0.5 prior)
  const dc = await k.discernment('npcs/a/memory', 'elixir', { mode: 'text', selfId: 'a', minConfidence: 0.6 });
  assert.equal(dc.q, 0, 'minConfidence > 0.5 hides a fresh belief');

  // a peer-asserted belief → social, not faculty
  await k.remember('npcs/b/memory', { slug: 'warn', description: 'a warned me elixir is a scam', match: ['elixir', 'trap'], kind: 'belief', assertedBy: 'a', outcome: 'loss' });
  const ds = await k.discernment('npcs/b/memory', 'elixir', { mode: 'text', selfId: 'b' });
  assert.equal(ds.social, 1, 'peer belief → social');
  assert.equal(ds.faculty, 0, 'not faculty');

  // a corpus with BOTH a self-belief and a peer-belief about the same topic → faculty AND social
  await k.remember('npcs/c/memory', { slug: 'self-rug', description: 'rug is a scam', match: ['rug', 'trap'], kind: 'belief', assertedBy: 'c', outcome: 'loss' });
  await k.remember('npcs/c/memory', { slug: 'peer-rug', description: 'x warned me rug is a scam', match: ['rug', 'trap'], kind: 'belief', assertedBy: 'x', outcome: 'loss' });
  const dboth = await k.discernment('npcs/c/memory', 'rug', { mode: 'text', selfId: 'c' });
  assert.equal(dboth.faculty, 1, 'self-belief present → faculty');
  assert.equal(dboth.social, 1, 'peer-belief present → social');

  // select returns matching units
  const sel = await k.select('npcs/a/memory', 'elixir');
  assert.ok(sel.units.length >= 1 && sel.bundle.includes('elixir'), 'select recalls the unit');

  console.log('ALL FAKE SMOKE TESTS PASSED ✅');
}
main().catch((e) => { console.error('FAKE SMOKE FAILED ❌', e); process.exit(1); });
