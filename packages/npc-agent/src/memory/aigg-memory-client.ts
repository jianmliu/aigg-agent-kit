/**
 * AiggMemoryClient — thin HTTP client for agentmf serve /memory/* endpoints.
 *
 * Covers the four endpoints added in AgentMakefile feat/memory-serve-endpoints:
 *   POST /memory/observe      record one observation → evidence JSONL (online)
 *   POST /memory/consolidate  Dream: promote episodic → typed units (offline)
 *   POST /memory/select       keyword retrieval → context bundle (online)
 *   POST /memory/units        list all typed units in a corpus
 *
 * The client is deliberately thin: it speaks the agentmf serve JSON envelope
 * ({ok, diagnostics, data}) and surfaces errors as thrown exceptions.
 * No retry / circuit-breaker — callers (SharedWorld) fire-and-forget observe
 * and catch+log errors on consolidate so a slow memory service never blocks
 * the hot talk() path.
 */
export interface ObservePayload {
  /** unit slug — identifies the memory unit this observation contributes to */
  slug: string;
  /** human-readable name of the unit */
  name: string;
  /** procedural | semantic | episodic */
  kind?: string;
  description?: string;
  /** keywords for retrieval (match.user_intent) */
  match?: string[];
  body?: string;
}

export interface ObserveResult {
  event_id: string;
  fingerprint: string;
  timestamp: string;
  source: string;
  outcome: string | null;
}

export interface MemoryUnit {
  path: string;
  name: string;
  kind: string;
  description: string;
  status: string;
  observations: number;
  confidence: string;
  match_terms: string[];
  /** only present in select results */
  score?: number;
  body?: string;
}

export interface SelectResult {
  units: MemoryUnit[];
  /** kind-aware bundle ready to inject into a prompt */
  bundle: string;
  total_in_corpus: number;
}

export interface ConsolidateResult {
  proposals: Array<{ proposal_id: string; title: string }>;
  gates: Array<{ name: string; passed: boolean; detail: string }>;
  gates_ok: boolean;
  written: boolean;
  units_after: MemoryUnit[];
}

export interface UnitsResult {
  corpus: string;
  units: MemoryUnit[];
  total: number;
}

/** A synthesized forward intention (kind=plan, status=candidate). */
export interface PlanUnit { slug: string; name: string; description?: string; body?: string; valid_from?: string; derived_from?: string[] }
export interface PlanResult { plans: PlanUnit[]; written?: boolean }

/** discernment — a decision read out of memory: relevant belief AND confidence ≥ θ. */
export interface DiscernmentResult { q: number; faculty: number; social: number; confidence: number }

export interface AiggMemoryClientOptions {
  /** base URL of the agentmf serve process, e.g. "http://localhost:8787" */
  baseUrl: string;
  /** optional Bearer token (agentmf serve --token) */
  token?: string;
  /**
   * corpus directory relative to the server's root (passed per-request so one
   * client can serve multiple NPC corpora without restart). Default "memory".
   */
  defaultCorpus?: string;
  /**
   * evidence JSONL path relative to server root. Default "memory/evidence.jsonl".
   * Use per-NPC paths like "npcs/<id>/evidence.jsonl" for isolation.
   */
  defaultEvidence?: string;
}

export class AiggMemoryClient {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  readonly defaultCorpus: string;
  readonly defaultEvidence: string;

  constructor(opts: AiggMemoryClientOptions) {
    this.base = opts.baseUrl.replace(/\/$/, '');
    this.headers = { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) };
    this.defaultCorpus = opts.defaultCorpus ?? 'memory';
    this.defaultEvidence = opts.defaultEvidence ?? 'memory/evidence.jsonl';
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const resp = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    const env = await resp.json() as { ok: boolean; data: T; diagnostics: Array<{ code: string; message: string }> };
    if (!env.ok) {
      const msg = env.diagnostics?.map((d) => `${d.code}: ${d.message}`).join('; ') ?? `HTTP ${resp.status}`;
      throw new Error(`[aigg-memory] ${path} failed — ${msg}`);
    }
    return env.data;
  }

  /** Record one observation into the evidence store (online, cheap). */
  async observe(
    payload: ObservePayload,
    opts?: { corpus?: string; evidence?: string; outcome?: 'correction' | 'obsolete' | null }
  ): Promise<ObserveResult> {
    return this.post('/memory/observe', {
      evidence: opts?.evidence ?? this.defaultEvidence,
      source: 'observation',
      payload,
      ...(opts?.outcome ? { outcome: opts.outcome } : {}),
    });
  }

  /**
   * Offline Dream consolidation: promotes repeated episodic observations into
   * typed memory units. Set write=true to commit when all gates pass.
   */
  async consolidate(opts?: { corpus?: string; evidence?: string; write?: boolean }): Promise<ConsolidateResult> {
    return this.post('/memory/consolidate', {
      corpus: opts?.corpus ?? this.defaultCorpus,
      evidence: opts?.evidence ?? this.defaultEvidence,
      write: opts?.write ?? false,
    });
  }

  /**
   * remember — write ONE structured fact straight into memory as a unit (no LLM,
   * no repetition gate). The host's deterministic "remember this now" path: use it
   * for a fact the NPC already has structured (a relationship note, a learned trap,
   * a promise). For raw dialogue that needs extraction, use ingest(). `consolidate`
   * does NOT extract — it only promotes already-structured observations, so this is
   * the right write path for the MUD's known facts.
   */
  async remember(payload: { name?: string; slug?: string; kind?: string; description: string; match?: string[]; body?: string; asserted_by?: string; valid_from?: string; outcome?: 'loss' | 'gain' | 'neutral'; predicts?: string[]; derived_from?: string[]; source_events?: unknown[] }, opts?: { corpus?: string; evidence?: string }): Promise<{ ok?: boolean; units?: MemoryUnit[] }> {
    return this.post('/memory/remember', {
      corpus: opts?.corpus ?? this.defaultCorpus,
      evidence: opts?.evidence ?? this.defaultEvidence,
      payload,
    });
  }

  /**
   * ingest — extract typed units from RAW dialogue/text via the model (the
   * gemma4-tolerant extraction path). Needs a model backend (aiggUrl/backend/model).
   * For facts the host already has structured, prefer remember() (zero-cost).
   */
  async ingest(text: string, opts?: { corpus?: string; evidence?: string; write?: boolean; aiggUrl?: string; aiggKey?: string; model?: string; backend?: string; timeout?: number }): Promise<{ ok?: boolean; units?: MemoryUnit[] }> {
    return this.post('/memory/ingest', {
      corpus: opts?.corpus ?? this.defaultCorpus,
      evidence: opts?.evidence ?? this.defaultEvidence,
      text,
      write: opts?.write ?? true,
      timeout: opts?.timeout ?? 180,
      ...(opts?.aiggUrl ? { aigg_url: opts.aiggUrl } : {}),
      ...(opts?.aiggKey ? { aigg_key: opts.aiggKey } : {}),
      ...(opts?.model ? { model: opts.model } : {}),
      ...(opts?.backend ? { backend: opts.backend } : {}),
    });
  }

  /**
   * reflect — Dream's belief-former: cluster the corpus's episodes and synthesize
   * BELIEFS (kind=belief) over a model backend (tolerant of small local models,
   * e.g. Ollama gemma4). The cognition step `consolidate` is not: consolidate
   * promotes structured observations; reflect forms new conclusions from them.
   */
  async reflect(opts: { corpus?: string; write?: boolean; aiggUrl: string; aiggKey?: string; model?: string; backend?: string; timeout?: number; threshold?: number }): Promise<{ written?: string[]; proposals?: unknown[] }> {
    return this.post('/memory/reflect', {
      corpus: opts.corpus ?? this.defaultCorpus,
      write: opts.write ?? true,
      aigg_url: opts.aiggUrl,
      timeout: opts.timeout ?? 180, // local models cold-load + generate slowly; 30s default times out
      ...(opts.aiggKey ? { aigg_key: opts.aiggKey } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.backend ? { backend: opts.backend } : {}),
      ...(opts.threshold != null ? { threshold: opts.threshold } : {}),
    });
  }

  /**
   * verify — the trust axis: a DETERMINISTIC, no-LLM sweep that scores beliefs
   * against outcome-tagged episodes (and skills against invocation outcomes);
   * refuted beliefs go `stale`. Confidence feeds discernment()'s θ-gate. The host
   * must have tagged outcomes (remember(payload.outcome)) for this to bite.
   */
  async verify(opts?: { corpus?: string; write?: boolean; now?: string; refuteThreshold?: number }): Promise<{ verified?: Record<string, { hits?: number; misses?: number; confidence?: number; stale?: boolean; predicts?: string[] }> }> {
    return this.post('/memory/verify', {
      corpus: opts?.corpus ?? this.defaultCorpus,
      write: opts?.write ?? true,
      ...(opts?.now ? { now: opts.now } : {}),
      ...(opts?.refuteThreshold != null ? { refute_threshold: opts.refuteThreshold } : {}),
    });
  }

  /**
   * discernment — decide BY memory (deterministic, no LLM): is there a belief
   * RELEVANT to `topic` (mode:'provenance' reads its evidence, not its wording)
   * whose verified confidence ≥ minConfidence? `q` is the discernment the host
   * reads at decision time; faculty=1 self-learned, social=1 peer-warned.
   */
  async discernment(topic: string, opts?: { corpus?: string; marker?: string; mode?: 'text' | 'provenance'; minConfidence?: number; talent?: number; selfId?: string }): Promise<DiscernmentResult> {
    return this.post('/memory/discernment', {
      corpus: opts?.corpus ?? this.defaultCorpus,
      topic,
      mode: opts?.mode ?? 'provenance',
      ...(opts?.marker ? { marker: opts.marker } : {}),
      ...(opts?.minConfidence != null ? { min_confidence: opts.minConfidence } : {}),
      ...(opts?.talent != null ? { talent: opts.talent } : {}),
      ...(opts?.selfId ? { self_id: opts.selfId } : {}),
    });
  }

  /**
   * plan — synthesize forward intentions (kind=plan) from goals + beliefs (the
   * forward mirror of consolidate/reflect). `now` is required (the kernel ships
   * no clock). The server's planner needs a model: pass `aiggUrl`/`backend`/`model`
   * (e.g. Ollama's OpenAI endpoint) — or `backend:"claude-cli"`. The kernel never
   * acts on a plan; the host (MUD) reads it and decides.
   */
  async plan(opts: { now: string; corpus?: string; goals?: string[]; write?: boolean; horizon?: string; aiggUrl?: string; aiggKey?: string; model?: string; backend?: string; timeout?: number }): Promise<PlanResult> {
    return this.post('/memory/plan', {
      corpus: opts.corpus ?? this.defaultCorpus,
      now: opts.now,
      write: opts.write ?? false,
      timeout: opts.timeout ?? 180, // a local model is slow (cold-load + generate) — 30s default times out
      ...(opts.goals ? { goals: opts.goals } : {}),
      ...(opts.horizon ? { horizon: opts.horizon } : {}),
      ...(opts.aiggUrl ? { aigg_url: opts.aiggUrl } : {}),
      ...(opts.aiggKey ? { aigg_key: opts.aiggKey } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.backend ? { backend: opts.backend } : {}),
    });
  }

  /** Keyword retrieval of relevant memory units for an NPC conversation (online, cheap). */
  async select(
    request: string,
    opts?: { corpus?: string; n_best?: number; kinds?: string[] }
  ): Promise<SelectResult> {
    return this.post('/memory/select', {
      request,
      corpus: opts?.corpus ?? this.defaultCorpus,
      ...(opts?.n_best != null ? { n_best: opts.n_best } : {}),
      ...(opts?.kinds ? { kinds: opts.kinds } : {}),
    });
  }

  /** List all typed units in a corpus. */
  async units(opts?: { corpus?: string }): Promise<UnitsResult> {
    return this.post('/memory/units', { corpus: opts?.corpus ?? this.defaultCorpus });
  }
}
