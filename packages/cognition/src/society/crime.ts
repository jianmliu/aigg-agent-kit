import type { Cognition } from '../cognition';
import type { RapSheet } from './rapsheet';
import { recordMisconduct } from './misconduct';

export const P_DETECT = 0.5;
export type CrimeKind = 'extort' | 'sabotage';

/** Probabilistic detection roll: caught? `rng` injectable for deterministic tests (default Math.random). */
export function detect(p: number = P_DETECT, rng: () => number = Math.random): boolean {
  return rng() < p;
}

/** Attempt a crime: roll detection (or use `force` if given); on catch, write the SAME misconduct signal a
 *  default does (rap entry + offender-scoped belief + one-time trust drop, via recordMisconduct). Uncaught →
 *  no trail. Best-effort (recordMisconduct is non-throwing). `force` overrides the roll — for deterministic tests. */
export async function attemptCrime(
  cognition: Cognition, rapSheet: RapSheet,
  victim: string, offender: string, kind: CrimeKind, now: number,
  opts: { detectP?: number; rng?: () => number; force?: boolean; detail?: string } = {},
): Promise<{ detected: boolean; topic?: string }> {
  const detected = opts.force ?? detect(opts.detectP ?? P_DETECT, opts.rng);
  if (!detected) return { detected: false };
  const topic = await recordMisconduct(cognition, rapSheet, victim, offender, kind, now, opts.detail);
  return { detected: true, topic };
}
