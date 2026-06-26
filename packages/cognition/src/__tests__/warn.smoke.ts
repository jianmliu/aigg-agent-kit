/** Smoke for diffuseWarning (trust-gated peer belief implant). Run: pnpm --filter @aigg/cognition test:warn */
import assert from 'node:assert/strict';
import { FakeKernel } from '../kernel/fake';
import { TrustLedger, TRUST_DELTAS } from '../social/trust';
import { diffuseWarning } from '../social/warn';
import { corpusPath, corpusId } from '../id';

async function main() {
  const k = new FakeKernel();
  const trust = new TrustLedger();
  const A = 'npc:abao', L = 'npc:liu';

  // A has no belief yet → warning rejected
  let r = await diffuseWarning(k, trust, A, L, 'elixir');
  assert.equal(r.accepted, false, 'no source belief → rejected');

  // give A a self-belief about elixir
  await k.remember(corpusPath(A), { slug: 'belief-elixir', description: 'elixir is a scam', match: ['elixir', 'trap'], kind: 'belief', assertedBy: corpusId(A), outcome: 'loss' });

  // L trusts A (neutral 0 ≥ default threshold 0) → accepted, L gains a SOCIAL belief
  r = await diffuseWarning(k, trust, A, L, 'elixir');
  assert.equal(r.accepted, true, 'source belief + sufficient trust → accepted');
  const dL = await k.discernment(corpusPath(L), 'elixir', { mode: 'text', selfId: corpusId(L) });
  assert.equal(dL.social, 1, 'L now has a social belief');
  assert.equal(dL.faculty, 0, 'not faculty (peer-asserted)');

  // if L distrusts A below threshold → rejected
  const k2 = new FakeKernel(); const trust2 = new TrustLedger();
  await k2.remember(corpusPath(A), { slug: 'b', description: 'elixir scam', match: ['elixir', 'trap'], kind: 'belief', assertedBy: corpusId(A), outcome: 'loss' });
  await trust2.update(L, A, TRUST_DELTAS.scammed);   // L's trust in A = -0.3
  r = await diffuseWarning(k2, trust2, A, L, 'elixir', { threshold: 0 });
  assert.equal(r.accepted, false, 'distrust below threshold → rejected');

  console.log('ALL WARN SMOKE TESTS PASSED ✅');
}
main().catch((e) => { console.error('WARN SMOKE FAILED ❌', e); process.exit(1); });
