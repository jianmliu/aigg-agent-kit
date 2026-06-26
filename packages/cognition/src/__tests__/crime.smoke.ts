/** Smoke for the crime primitive. Run: pnpm --filter @onchainpal/cognition test:crime */
import assert from 'node:assert/strict';
import { FakeKernel } from '../kernel/fake';
import { TrustLedger } from '../social/trust';
import { Cognition } from '../cognition';
import { RapSheet } from '../society/rapsheet';
import { detect, attemptCrime, P_DETECT } from '../society/crime';

async function main() {
  assert.equal(P_DETECT, 0.5);
  // detect honors the injected rng
  assert.equal(detect(0.5, () => 0), true, 'rng 0 < 0.5 → caught');
  assert.equal(detect(0.5, () => 0.9), false, 'rng 0.9 ≥ 0.5 → not caught');

  const victim = 'npc:han', offender = 'visitor:1';

  // uncaught (rng high) → no rap, no belief
  const cog1 = new Cognition(new FakeKernel(), new TrustLedger());
  const rap1 = new RapSheet();
  const r1 = await attemptCrime(cog1, rap1, victim, offender, 'sabotage', 1, { rng: () => 0.99 });
  assert.equal(r1.detected, false, 'uncaught');
  assert.equal(r1.topic, undefined, 'no topic when uncaught');
  assert.equal(rap1.has(offender), false, 'uncaught → no rap entry');

  // caught (rng 0) → rap entry + offender-scoped belief
  const cog2 = new Cognition(new FakeKernel(), new TrustLedger());
  const rap2 = new RapSheet();
  const r2 = await attemptCrime(cog2, rap2, victim, offender, 'sabotage', 1, { rng: () => 0, detail: 'trashed the stall' });
  assert.equal(r2.detected, true, 'caught');
  assert.ok(r2.topic, 'topic returned on catch');
  assert.equal(rap2.has(offender), true, 'caught → rap written');
  assert.equal(rap2.entries(offender)[0].kind, 'sabotage', 'rap kind is the crime kind');
  const sig = await cog2.recall(victim, offender, r2.topic!);
  assert.equal(sig.discernment.q, 1, 'victim recalls the crime belief');

  // force overrides the roll (the deterministic dev seam)
  const cog3 = new Cognition(new FakeKernel(), new TrustLedger());
  const rap3 = new RapSheet();
  const r3 = await attemptCrime(cog3, rap3, victim, offender, 'extort', 1, { force: true, rng: () => 0.99 });
  assert.equal(r3.detected, true, 'force:true overrides the roll → caught');
  assert.equal(rap3.has(offender), true, 'force:true wrote a rap');

  const cog4 = new Cognition(new FakeKernel(), new TrustLedger());
  const rap4 = new RapSheet();
  const r4 = await attemptCrime(cog4, rap4, victim, offender, 'extort', 1, { force: false, rng: () => 0 });
  assert.equal(r4.detected, false, 'force:false overrides the roll → uncaught');
  assert.equal(rap4.has(offender), false, 'force:false wrote no rap');

  console.log('ALL CRIME SMOKE TESTS PASSED ✅');
}
main().catch((e) => { console.error('CRIME SMOKE FAILED ❌', e); process.exit(1); });
