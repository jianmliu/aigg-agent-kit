import type { MemoryKernel } from './port';
import type { Discernment, RememberInput, SelectResult, DiscernOpts } from '../types';

type FetchLike = typeof fetch;

export interface AiggMemoryKernelOpts {
  baseUrl: string;                                   // aigg-memory service, e.g. http://localhost:8787
  token?: string;
  reflect?: { aiggUrl: string; model?: string; backend?: string };   // LLM backend for reflect()
  fetchImpl?: FetchLike;                             // injectable for tests
}

/** HTTP adapter to the external aigg-memory service. Mirrors the existing
 *  AiggMemoryClient wire shapes, with two audit-mandated differences:
 *   - remember nests fields inside `payload` (body-level outcome would skip the record)
 *   - discernment defaults to mode:'text' (a fresh belief has no derived_from → invisible in provenance) */
export class AiggMemoryKernel implements MemoryKernel {
  private base: string;
  private headers: Record<string, string>;
  private f: FetchLike;

  constructor(private opts: AiggMemoryKernelOpts) {
    this.base = opts.baseUrl.replace(/\/$/, '');
    this.headers = { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) };
    this.f = opts.fetchImpl ?? fetch;
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const resp = await this.f(`${this.base}${path}`, { method: 'POST', headers: this.headers, body: JSON.stringify(body) });
    const env = (await resp.json()) as { ok: boolean; data: T; diagnostics?: Array<{ code: string; message: string }> };
    if (!env.ok) throw new Error(`[aigg-memory] ${path} — ${env.diagnostics?.map((d) => d.message).join('; ') ?? 'failed'}`);
    return env.data;
  }

  private evidence(corpus: string): string { return `${corpus}/evidence.jsonl`; }

  async remember(corpus: string, fact: RememberInput): Promise<void> {
    await this.post('/memory/remember', {
      corpus,
      evidence: this.evidence(corpus),
      payload: {
        slug: fact.slug,
        name: fact.slug,
        description: fact.description,
        match: fact.match,
        kind: fact.kind ?? 'episodic',
        ...(fact.assertedBy ? { asserted_by: fact.assertedBy } : {}),
        ...(fact.outcome ? { outcome: fact.outcome } : {}),
        ...(fact.predicts ? { predicts: [fact.predicts] } : {}),
      },
    });
  }

  async discernment(corpus: string, topic: string, opts: DiscernOpts = {}): Promise<Discernment> {
    return this.post('/memory/discernment', {
      corpus,
      topic,
      mode: opts.mode ?? 'text',
      ...(opts.marker ? { marker: opts.marker } : {}),
      ...(opts.minConfidence != null ? { min_confidence: opts.minConfidence } : {}),
      ...(opts.talent != null ? { talent: opts.talent } : {}),
      ...(opts.selfId ? { self_id: opts.selfId } : {}),
    });
  }

  async verify(corpus: string, opts: { now?: string; refuteThreshold?: number } = {}): Promise<{ verified: number; stale: number }> {
    const data = await this.post<{ verified?: Record<string, { stale?: boolean }> }>('/memory/verify', {
      corpus, write: true,
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.refuteThreshold != null ? { refute_threshold: opts.refuteThreshold } : {}),
    });
    const recs = Object.values(data.verified ?? {});
    return { verified: recs.length, stale: recs.filter((r) => r.stale).length };
  }

  async select(corpus: string, request: string, opts: { nBest?: number; kinds?: string[] } = {}): Promise<SelectResult> {
    const data = await this.post<{ units?: Array<{ path: string; description: string; kind: string }>; bundle?: string; total_in_corpus?: number }>('/memory/select', {
      corpus, request,
      ...(opts.nBest != null ? { n_best: opts.nBest } : {}),
      ...(opts.kinds ? { kinds: opts.kinds } : {}),
    });
    return {
      units: (data.units ?? []).map((u) => ({ slug: u.path, description: u.description, kind: u.kind })),
      bundle: data.bundle ?? '',
      total: data.total_in_corpus ?? 0,
    };
  }

  async reflect(corpus: string): Promise<{ beliefs: number }> {
    if (!this.opts.reflect) throw new Error('reflect: no LLM backend configured');
    const data = await this.post<{ written?: string[] }>('/memory/reflect', {
      corpus, write: true,
      aigg_url: this.opts.reflect.aiggUrl,
      ...(this.opts.reflect.model ? { model: this.opts.reflect.model } : {}),
      ...(this.opts.reflect.backend ? { backend: this.opts.reflect.backend } : {}),
    });
    return { beliefs: (data.written ?? []).length };
  }
}
