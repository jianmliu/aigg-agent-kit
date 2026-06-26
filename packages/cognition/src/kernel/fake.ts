import type { MemoryKernel } from './port';
import type { Discernment, RememberInput, SelectResult, DiscernOpts } from '../types';

interface StoredFact extends RememberInput { corpus: string }

/** In-memory MemoryKernel matching aigg-memory's observable semantics for ②a:
 *  text-mode discernment over match terms, self-vs-social by assertedBy, 0.5 prior. */
export class FakeKernel implements MemoryKernel {
  readonly facts: StoredFact[] = [];   // public for test assertions

  async remember(corpus: string, fact: RememberInput): Promise<void> {
    this.facts.push({ corpus, ...fact });
  }

  async discernment(corpus: string, topic: string, opts: DiscernOpts = {}): Promise<Discernment> {
    const mode = opts.mode ?? 'text';
    // fresh beliefs carry exactly the 0.5 prior, so a whole-response gate is equivalent to per-belief here
    if (opts.minConfidence != null && 0.5 < opts.minConfidence) return { q: 0, faculty: 0, social: 0, confidence: 0 };
    const matches = this.facts.filter((f) => f.corpus === corpus && f.kind === 'belief' && this.about(f, topic, mode));
    let faculty = 0, social = 0;
    for (const b of matches) {
      const ab = b.assertedBy;
      if (ab == null || ab === 'self' || ab === opts.selfId) faculty = 1; else social = 1;
    }
    const present = faculty || social;
    return { q: present ? 1 : 0, faculty, social, confidence: present ? 0.5 : 0 };
  }

  private about(f: StoredFact, topic: string, mode: 'text' | 'provenance'): boolean {
    if (mode === 'provenance') return false;   // a direct belief has no derived_from → invisible (mirrors the real kernel)
    const hay = `${f.slug} ${f.description} ${(f.match ?? []).join(' ')}`.toLowerCase();   // real _matches scans slug+description+match terms
    return hay.includes(topic.toLowerCase());
  }

  async verify(corpus: string): Promise<{ verified: number; stale: number }> {
    const recs = this.facts.filter((f) => f.corpus === corpus && f.kind === 'belief');
    return { verified: recs.length, stale: 0 };
  }

  async select(corpus: string, request: string): Promise<SelectResult> {
    const hit = (f: StoredFact) => `${f.slug} ${f.description} ${(f.match ?? []).join(' ')}`.toLowerCase().includes(request.toLowerCase());
    const units = this.facts.filter((f) => f.corpus === corpus && hit(f)).map((f) => ({ slug: f.slug, description: f.description, kind: f.kind ?? 'episodic' }));
    return { units, bundle: units.map((u) => `- ${u.description}`).join('\n'), total: this.facts.filter((f) => f.corpus === corpus).length };   // matches the real kernel's total_in_corpus (corpus size, not match count)
  }

  async reflect(corpus: string): Promise<{ beliefs: number }> {
    let n = 0;
    for (const f of this.facts.filter((f) => f.corpus === corpus && f.kind === 'episodic')) {
      const slug = `belief-${f.slug}`;
      if (!this.facts.some((b) => b.corpus === corpus && b.slug === slug)) {
        this.facts.push({ corpus, slug, description: f.description, match: f.match, kind: 'belief', assertedBy: 'self', outcome: f.outcome });   // 'self' is treated as faculty for any selfId in discernment()
        n++;
      }
    }
    return { beliefs: n };
  }
}
