/** Smoke for the belief-gating bridge (composes ②a Cognition + Polity).
 *  Run: pnpm --filter @aigg/cognition test:governance */
import assert from 'node:assert/strict';
import { FakeKernel } from '../kernel/fake';
import { TrustLedger } from '../social/trust';
import { Cognition } from '../cognition';
import { Polity } from '../governance/polity';
import { voteBeliefGated, runSanctionVote } from '../governance/voting';
import type { MemoryKernel } from '../kernel/port';

async function main() {
  const topic = 'elixir';
  const V = 'visitor:1';
  const guild = ['npc:a', 'npc:b', 'npc:c', 'npc:d', 'npc:e'];

  // A learns the scam, then warns the rest of the guild (②a)
  const cog = new Cognition(new FakeKernel(), new TrustLedger());
  await cog.learn('npc:a', V, { topic, description: 'the elixir pitch cost me 3 $0G', outcome: 'loss' });
  for (const g of guild) if (g !== 'npc:a') await cog.warn('npc:a', g, topic);

  // a warned member votes 'for'; an unwarned outsider votes 'against'
  assert.equal(await voteBeliefGated(cog, 'npc:b', V, topic), 'for', 'warned member votes for');
  assert.equal(await voteBeliefGated(cog, 'npc:zzz', V, topic), 'against', 'unwarned outsider votes against');

  // runSanctionVote PASSES with a warned guild
  const polity = new Polity();
  const round = await runSanctionVote(cog, polity, 'npc:a', V, topic, guild, { until: Infinity });
  assert.ok(round, 'proposer believes → a round runs');
  assert.equal(round!.result.passed, true, 'warned guild passes the ban');
  assert.equal(polity.sanctioned(V), true, 'visitor is sanctioned');

  // FAILS when only the proposer believes (no warnings) → 1/5 < 0.6
  const cog2 = new Cognition(new FakeKernel(), new TrustLedger());
  await cog2.learn('npc:a', V, { topic, description: 'lost', outcome: 'loss' });
  const polity2 = new Polity();
  const round2 = await runSanctionVote(cog2, polity2, 'npc:a', V, topic, guild, { until: Infinity });
  assert.equal(round2!.result.passed, false, 'only proposer believes → fails');
  assert.equal(polity2.sanctioned(V), false, 'no ban on a failed vote');

  // proposer doesn't believe → null (no proposal opened)
  const cog3 = new Cognition(new FakeKernel(), new TrustLedger());
  assert.equal(await runSanctionVote(cog3, new Polity(), 'npc:a', V, topic, guild), null, 'no belief → null');

  // fails-closed: a throwing kernel makes every vote 'against'
  const boom: MemoryKernel = {
    remember: async () => { throw new Error('down'); },
    discernment: async () => { throw new Error('down'); },
    verify: async () => { throw new Error('down'); },
    select: async () => { throw new Error('down'); },
    reflect: async () => { throw new Error('down'); },
  };
  const cog4 = new Cognition(boom, new TrustLedger());
  assert.equal(await voteBeliefGated(cog4, 'npc:b', V, topic), 'against', 'kernel down → against (fails closed)');

  console.log('ALL GOVERNANCE SMOKE TESTS PASSED ✅');
}
main().catch((e) => { console.error('GOVERNANCE SMOKE FAILED ❌', e); process.exit(1); });
