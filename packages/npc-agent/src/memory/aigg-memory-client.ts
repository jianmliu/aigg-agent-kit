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
   * plan — synthesize forward intentions (kind=plan) from goals + beliefs (the
   * forward mirror of consolidate/reflect). `now` is required (the kernel ships
   * no clock). The server's planner needs a model: pass `aiggUrl`/`backend`/`model`
   * (e.g. Ollama's OpenAI endpoint) — or `backend:"claude-cli"`. The kernel never
   * acts on a plan; the host (MUD) reads it and decides.
   */
  async plan(opts: { now: string; corpus?: string; goals?: string[]; write?: boolean; horizon?: string; aiggUrl?: string; aiggKey?: string; model?: string; backend?: string }): Promise<PlanResult> {
    return this.post('/memory/plan', {
      corpus: opts.corpus ?? this.defaultCorpus,
      now: opts.now,
      write: opts.write ?? false,
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
