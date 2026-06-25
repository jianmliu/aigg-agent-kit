import type { MemoryKernel } from './kernel/port';
import { TrustLedger, TRUST_DELTAS } from './social/trust';
import { diffuseWarning } from './social/warn';
import { corpusId, corpusPath } from './id';
import type { CognitiveSignal, Discernment, EpisodeInput, SelectResult } from './types';

const NEUTRAL: Discernment = { q: 0, faculty: 0, social: 0, confidence: 0 };
const EMPTY_SELECT: SelectResult = { units: [], bundle: '', total: 0 };

/** The middleware: hosts call recall() before the LLM and learn()/warn() after. */
export class Cognition {
  constructor(
    private kernel: MemoryKernel,
    private trust: TrustLedger,
    private opts: { reflectOnLearn?: boolean } = {},
  ) {}

  /** PRE: what self remembers about this topic + how it trusts this peer. Best-effort. */
  async recall(self: string, peer: string, topic: string): Promise<CognitiveSignal> {
    const corpus = corpusPath(self);
    let discernment: Discernment = NEUTRAL;
    let beliefs: SelectResult = EMPTY_SELECT;
    let trust = 0;
    try { discernment = await this.kernel.discernment(corpus, topic, { mode: 'text', selfId: corpusId(self) }); } catch { /* best-effort */ }
    try { beliefs = await this.kernel.select(corpus, topic); } catch { /* best-effort */ }
    try { trust = await this.trust.get(self, peer); } catch { /* best-effort */ }
    return { discernment, trust, beliefs, summary: this.buildSummary(discernment, beliefs, trust) };
  }

  /** POST: record the episode (+ a direct belief on a loss) and update peer trust. */
  async learn(self: string, peer: string, ep: EpisodeInput): Promise<void> {
    const corpus = corpusPath(self);
    const sid = corpusId(self);
    const slug = `ep-${ep.topic}-${ep.outcome}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    const formBelief = ep.formBelief ?? ep.outcome === 'loss';
    const match = [ep.topic, 'trap'];
    try {
      await this.kernel.remember(corpus, { slug, description: ep.description, match, kind: 'episodic', assertedBy: sid, outcome: ep.outcome });
      if (formBelief) {
        await this.kernel.remember(corpus, { slug: `belief-${slug}`, description: ep.description, match, kind: 'belief', assertedBy: sid, outcome: ep.outcome });
      }
    } catch { /* best-effort */ }
    try {
      const delta = ep.outcome === 'loss' ? TRUST_DELTAS.scammed : ep.outcome === 'gain' ? TRUST_DELTAS.honestDeal : 0;
      if (delta) await this.trust.update(self, peer, delta);
    } catch { /* best-effort */ }
    if (this.opts.reflectOnLearn) void this.reflect(self);
  }

  /** Diffuse a warning from one NPC to another (trust-gated). Best-effort → false on error. */
  async warn(from: string, to: string, topic: string): Promise<boolean> {
    try { return (await diffuseWarning(this.kernel, this.trust, from, to, topic)).accepted; } catch { return false; }
  }

  /** Run the optional LLM reflection pass for one NPC. Best-effort (no-op if unavailable). */
  async reflect(self: string): Promise<void> {
    try { await this.kernel.reflect(corpusPath(self)); } catch { /* reflection unavailable */ }
  }

  private buildSummary(d: Discernment, beliefs: SelectResult, trust: number): string {
    const parts: string[] = [];
    if (d.faculty || d.social) parts.push(beliefs.bundle || 'You recall this has burned you before.');
    if (trust <= TRUST_DELTAS.scammed) parts.push(`You distrust this visitor (trust ${trust.toFixed(2)}).`);
    return parts.join(' ');
  }
}
