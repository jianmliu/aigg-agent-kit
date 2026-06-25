import type { CognitiveSignal } from './types';

/** Deterministic short-circuit for pitch-like decisions: refuse on a strong belief
 *  (q over threshold, mirroring monopoly's FOLLOW_THRESHOLD) or on deep distrust. */
export function shouldRefuse(
  signal: CognitiveSignal,
  opts: { qThreshold?: number; trustFloor?: number } = {},
): { refuse: boolean; reason?: string } {
  const qThreshold = opts.qThreshold ?? 0.5;
  const trustFloor = opts.trustFloor ?? -0.5;
  if (signal.discernment.q > qThreshold) return { refuse: true, reason: 'I remember this is a scam.' };
  if (signal.trust < trustFloor) return { refuse: true, reason: "I don't trust you." };
  return { refuse: false };
}
