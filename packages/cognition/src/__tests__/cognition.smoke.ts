/** Smoke for the Cognition orchestrator. Run: pnpm --filter @onchainpal/cognition test:cognition */
import assert from 'node:assert/strict';
import { FakeKernel } from '../kernel/fake';
import { TrustLedger, TRUST_DELTAS } from '../social/trust';
import { Cognition } from '../cognition';
import type { MemoryKernel } from '../kernel/port';

async function main() {
  const k = new FakeKernel();
  const trust = new TrustLedger();
  const cog = new Cognition(k, trust);
  const A = 'npc:abao', L = 'npc:liu', V = 'visitor:1';

  // before learning: recall is neutral
  let s = await cog.recall(A, V, 'elixir');
  assert.equal(s.discernment.q, 0, 'no memory yet → q=0');
  assert.equal(s.trust, 0, 'neutral trust');

  // learn a loss → forms a belief + drops visitor trust
  await cog.learn(A, V, { topic: 'elixir', description: 'the elixir pitch cost me 3 $0G', outcome: 'loss' });
  s = await cog.recall(A, V, 'elixir');
  assert.equal(s.discernment.q, 1, 'after learn(loss) → q=1');
  assert.equal(s.discernment.faculty, 1, 'self-learned');
  assert.ok(s.summary.length > 0, 'summary is non-empty');
  assert.ok(Math.abs(s.trust - TRUST_DELTAS.scammed) < 1e-9, 'visitor trust dropped');

  // warn Liu → Liu gains a social belief, refuses unburned
  const accepted = await cog.warn(A, L, 'elixir');
  assert.equal(accepted, true, 'warning accepted');
  const sl = await cog.recall(L, V, 'elixir');
  assert.equal(sl.discernment.social, 1, 'Liu has a peer-warned belief');
  assert.equal(sl.discernment.faculty, 0, 'Liu never burned (not faculty)');
  assert.equal(sl.discernment.q, 1, 'Liu would refuse');

  // best-effort: a throwing kernel makes recall return the neutral signal, not throw
  const boom: MemoryKernel = {
    remember: async () => { throw new Error('down'); },
    discernment: async () => { throw new Error('down'); },
    verify: async () => { throw new Error('down'); },
    select: async () => { throw new Error('down'); },
    reflect: async () => { throw new Error('down'); },
  };
  const cog2 = new Cognition(boom, new TrustLedger());
  const neutral = await cog2.recall(A, V, 'elixir');
  assert.deepEqual(neutral.discernment, { q: 0, faculty: 0, social: 0, confidence: 0 }, 'kernel down → neutral signal');
  await cog2.learn(A, V, { topic: 'x', description: 'y', outcome: 'loss' });   // must not throw
  assert.equal(await cog2.warn('npc:a', 'npc:b', 'elixir'), false, 'warn with a dead kernel → false (no throw)');

  // gain outcome raises peer trust
  await cog.learn(A, 'visitor:2', { topic: 'fair-deal', description: 'an honest trade', outcome: 'gain' });
  const sg = await cog.recall(A, 'visitor:2', 'fair-deal');
  assert.ok(sg.trust > 0, 'gain outcome raises peer trust');

  console.log('ALL COGNITION SMOKE TESTS PASSED ✅');
}
main().catch((e) => { console.error('COGNITION SMOKE FAILED ❌', e); process.exit(1); });
