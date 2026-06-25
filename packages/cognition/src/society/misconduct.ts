import type { Cognition } from '../cognition';
import type { Polity, TallyResult, Choice } from '../governance/polity';
import { corpusId } from '../id';
import type { RapSheet } from './rapsheet';

/** A stable, offender-scoped topic. The belief/sanction is keyed to the offender (not a claim),
 *  which sidesteps ②b's claim-scoped false-positive. */
export function misconductTopic(offender: string): string { return `misconduct-${corpusId(offender)}`; }

/** ②a bridge: on a confirmed misconduct, write the SAME signal a scam does — a rap entry, plus (via learn)
 *  the victim's offender-scoped belief and a victim→offender trust drop. Best-effort (learn is non-throwing).
 *  Takes NO TrustLedger — `cognition.learn` already owns/moves the one shared ledger (no double-apply). */
export async function recordMisconduct(
  cognition: Cognition, rapSheet: RapSheet,
  victim: string, offender: string, kind: string, now: number, detail?: string,
): Promise<string> {
  const topic = misconductTopic(offender);
  rapSheet.record(offender, { kind, victim, t: now });
  await cognition.learn(victim, offender, { topic, description: detail ?? `${offender} committed ${kind}`, outcome: 'loss' });
  return topic;
}

/** ②b bridge: the guild bans on PUBLIC evidence. If the offender has a rap sheet, the proposer opens a
 *  sanction and every guild member votes 'for' (the rap is public); tally. Returns null if the rap is clean.
 *  Reads ONLY rapSheet.has — does not consult per-voter beliefs. */
export async function runRapSanction(
  rapSheet: RapSheet, polity: Polity,
  proposer: string, offender: string, guild: string[],
  opts: { until?: number } = {},
): Promise<{ pid: string; result: TallyResult; votes: Record<string, Choice> } | null> {
  if (!rapSheet.has(offender)) return null;
  // topic carried for replay/viewer parity with ②b's runSanctionVote (viewer reads d.topic on town.propose)
  const pid = polity.submit(proposer, 'sanction', { target: offender, until: opts.until ?? Infinity, topic: misconductTopic(offender) });
  const votes: Record<string, Choice> = { [proposer]: 'for' };
  for (const m of guild) {
    if (m === proposer) continue;
    polity.cast(pid, m, 'for');
    votes[m] = 'for';
  }
  return { pid, result: polity.tally(pid, guild), votes };
}
