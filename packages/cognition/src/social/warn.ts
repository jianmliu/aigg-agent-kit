import type { MemoryKernel } from '../kernel/port';
import type { TrustLedger } from './trust';
import { corpusId, corpusPath } from '../id';

/** Diffuse a warning: if `from` holds a belief about `topic` and `to` trusts `from`
 *  enough, implant the belief into `to`'s corpus as a PEER-asserted belief so `to`'s
 *  later discernment(topic, {mode:'text'}) returns social=1. "A-Bao warns Keeper Liu." */
export async function diffuseWarning(
  kernel: MemoryKernel, trust: TrustLedger,
  from: string, to: string, topic: string,
  opts: { threshold?: number } = {},
): Promise<{ accepted: boolean; reason?: string }> {
  const threshold = opts.threshold ?? 0;
  const d = await kernel.discernment(corpusPath(from), topic, { mode: 'text', selfId: corpusId(from) });
  if (d.faculty <= 0) return { accepted: false, reason: 'source has no self-belief about this topic' };

  const t = await trust.get(to, from);
  if (t < threshold) return { accepted: false, reason: `target distrusts source (trust ${t.toFixed(2)})` };

  await kernel.remember(corpusPath(to), {
    slug: `warn-${corpusId(from)}-${topic}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80),
    description: `${from} warned me that "${topic}" is a scam.`,
    match: [topic, 'trap'],
    kind: 'belief',
    assertedBy: corpusId(from),     // peer provenance → social, not faculty, for `to`
    outcome: 'loss',
  });
  return { accepted: true };
}
