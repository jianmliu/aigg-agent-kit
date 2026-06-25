/** Smoke for the misconduct bridge (composes ②a Cognition + ②b Polity).
 *  Run: pnpm --filter @onchainpal/cognition test:society */
import assert from 'node:assert/strict';
import { FakeKernel } from '../kernel/fake';
import { TrustLedger, TRUST_DELTAS } from '../social/trust';
import { Cognition } from '../cognition';
import { Polity } from '../governance/polity';
import { RapSheet } from '../society/rapsheet';
import { recordMisconduct, runRapSanction, misconductTopic } from '../society/misconduct';

async function main() {
  const victim = 'npc:han', offender = 'visitor:1';
  const guild = ['npc:han', 'npc:liu', 'npc:mei', 'npc:guo', 'npc:abao'];

  // misconductTopic is stable + offender-scoped
  assert.equal(misconductTopic(offender), misconductTopic(offender), 'stable');
  assert.notEqual(misconductTopic(offender), misconductTopic('visitor:2'), 'offender-scoped');

  const cog = new Cognition(new FakeKernel(), new TrustLedger());
  const rap = new RapSheet();
  const polity = new Polity();

  // a clean offender → no proposal
  assert.equal(await runRapSanction(rap, polity, victim, offender, guild), null, 'clean offender → null');

  // record a default → rap entry + victim distrusts offender + victim recalls an offender-scoped belief
  const topic = await recordMisconduct(cog, rap, victim, offender, 'default', 1, 'stiffed a 10 $0G loan');
  assert.equal(topic, misconductTopic(offender), 'returns the topic');
  assert.equal(rap.has(offender), true, 'rap entry written');
  assert.equal(rap.entries(offender)[0].kind, 'default');
  const sig = await cog.recall(victim, offender, topic);
  assert.equal(sig.discernment.q, 1, 'victim recalls the misconduct belief');
  assert.ok(Math.abs(sig.trust - TRUST_DELTAS.scammed) < 1e-9, 'victim→offender trust dropped exactly once');

  // now the public rap drives a passing collective ban
  const round = await runRapSanction(rap, polity, victim, offender, guild, { until: Infinity });
  assert.ok(round, 'rap present → a round runs');
  assert.equal(round!.result.passed, true, 'guild bans on the public rap (all for)');
  assert.equal(polity.sanctioned(offender), true, 'offender blacklisted');

  console.log('ALL SOCIETY SMOKE TESTS PASSED ✅');
}
main().catch((e) => { console.error('SOCIETY SMOKE FAILED ❌', e); process.exit(1); });
