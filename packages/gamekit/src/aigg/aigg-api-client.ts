/**
 * AiggApiClient — HTTP client for the public (unauthenticated) AI.GG platform
 * API endpoints. Used to inject live data into functional NPC personas so
 * they can answer platform questions accurately.
 *
 * Phase 1: read-only public endpoints (no auth).
 *   GET /api/v1/pricing/gcc   — model GCC pricing table (per million tokens)
 *   GET /api/v1/payment/plans — subscription plans (if public)
 *
 * Phase 2 (auth): API-key creation, x402 top-up, ERC-8257 subscription.
 */

export interface ModelGccPricing {
  gcc_per_million_input: number;
  gcc_per_million_output: number;
}

export type GccPricingTable = Record<string, ModelGccPricing>;

export interface AiggApiClientOptions {
  /** AI.GG backend base URL. Default: https://ai.gg */
  baseUrl?: string;
  /** Optional bearer token for authenticated endpoints (phase 2). */
  token?: string;
  /** Fetch timeout ms. Default: 8000 */
  timeoutMs?: number;
}

export class AiggApiClient {
  private readonly base: string;
  private readonly token?: string;
  private readonly timeoutMs: number;

  constructor(opts: AiggApiClientOptions = {}) {
    this.base = (opts.baseUrl ?? 'https://ai.gg').replace(/\/$/, '');
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  private async get<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { 'Accept': 'application/json' };
      if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
      const resp = await fetch(`${this.base}${path}`, { headers, signal: controller.signal });
      if (!resp.ok) throw new Error(`AIGG API ${path} → ${resp.status}`);
      const body = await resp.json() as { code: number; data: T; message?: string };
      if (body.code !== 0) throw new Error(`AIGG API ${path} error: ${body.message}`);
      return body.data;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Public endpoint — no auth. Returns the GCC per-model pricing table:
   * { "claude-haiku-4-5": { gcc_per_million_input: 25, gcc_per_million_output: 125 }, ... }
   */
  async getGccPricing(): Promise<GccPricingTable> {
    return this.get<GccPricingTable>('/api/v1/pricing/gcc');
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Group the flat pricing table into provider buckets for readable output. */
export function formatGccPricing(table: GccPricingTable): string {
  // bucket by provider prefix
  const buckets: Record<string, Array<{ name: string; inp: number; out: number }>> = {};
  for (const [model, price] of Object.entries(table)) {
    const provider = model.startsWith('claude') ? 'Anthropic Claude'
      : model.startsWith('gemini') ? 'Google Gemini'
      : model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3') ? 'OpenAI'
      : model.startsWith('deepseek') ? 'DeepSeek'
      : model.startsWith('codex') ? 'Codex'
      : '其他';
    (buckets[provider] ??= []).push({ name: model, inp: price.gcc_per_million_input, out: price.gcc_per_million_output });
  }
  const lines: string[] = [];
  for (const [provider, models] of Object.entries(buckets)) {
    lines.push(`【${provider}】`);
    for (const m of models) {
      lines.push(`  ${m.name}: 输入 ${m.inp} GCC/M, 输出 ${m.out} GCC/M`);
    }
  }
  return lines.join('\n');
}

/** Estimate GCC cost for a given token count. */
export function estimateGcc(
  table: GccPricingTable,
  model: string,
  inputTokens: number,
  outputTokens: number
): number | null {
  const p = table[model];
  if (!p) return null;
  return (inputTokens * p.gcc_per_million_input + outputTokens * p.gcc_per_million_output) / 1_000_000;
}
