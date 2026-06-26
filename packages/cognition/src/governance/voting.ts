import type { Cognition } from '../cognition';
import type { Polity, Choice, TallyResult } from './polity';

/** Vote 'for' sanctioning `target` iff the voter recognizes the scam CLAIM (topic belief,
 *  which ②a's warning diffuses) OR distrusts the target. Best-effort via ②a's recall:
 *  a memory outage yields a neutral signal ⇒ 'against' (fails closed — no ban). */
export async function voteBeliefGated(
  cognition: Cognition, voter: string, target: string, topic: string,
  opts: { trustFloor?: number } = {},
): Promise<Choice> {
  const trustFloor = opts.trustFloor ?? -0.5;
  const sig = await cognition.recall(voter, target, topic);
  return (sig.discernment.q > 0 || sig.trust < trustFloor) ? 'for' : 'against';
}

/** A full synchronous sanction round for an event-driven host: if the proposer believes,
 *  submit a sanction, have every guild member cast a belief-gated vote, then tally NOW.
 *  Returns null if the proposer doesn't believe (no proposal opened). */
export async function runSanctionVote(
  cognition: Cognition, polity: Polity,
  proposer: string, target: string, topic: string, guild: string[],
  opts: { until?: number; trustFloor?: number } = {},
): Promise<{ pid: string; result: TallyResult; votes: Record<string, Choice> } | null> {
  if ((await voteBeliefGated(cognition, proposer, target, topic, opts)) !== 'for') return null;
  const pid = polity.submit(proposer, 'sanction', { target, until: opts.until ?? Infinity, topic });
  const votes: Record<string, Choice> = { [proposer]: 'for' };
  for (const member of guild) {
    if (member === proposer) continue;
    const choice = await voteBeliefGated(cognition, member, target, topic, opts);
    polity.cast(pid, member, choice);
    votes[member] = choice;
  }
  return { pid, result: polity.tally(pid, guild), votes };
}
