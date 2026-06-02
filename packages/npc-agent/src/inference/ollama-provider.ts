import type { InferenceProvider, InferenceRequest, InferenceResult } from './provider';

export interface OllamaProviderOptions {
  model?: string;
  endpoint?: string;
  /** GCC cost = (inputTok/1e6)*gccPerMInput + (outputTok/1e6)*gccPerMOutput. */
  pricing?: { gccPerMInput: number; gccPerMOutput: number };
  fetchImpl?: typeof fetch;
}

/**
 * OllamaProvider — the DEV inference provider (user decision 2026-05: dev uses
 * local Ollama). Implements the same InferenceProvider seam as the future hosted
 * AiggProvider, and still computes a `usage` (tokens + gccCost) so the
 * metering/settlement path can be exercised in dev even though no real GCC is
 * spent locally. No attestation (local, unsigned).
 */
export class OllamaProvider implements InferenceProvider {
  readonly id = 'ollama';
  private readonly model: string;
  private readonly endpoint: string;
  private readonly pricing: { gccPerMInput: number; gccPerMOutput: number };
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OllamaProviderOptions = {}) {
    this.model = opts.model ?? 'qwen3:8b';
    this.endpoint = opts.endpoint ?? 'http://localhost:11434/api/generate';
    this.pricing = opts.pricing ?? { gccPerMInput: 1, gccPerMOutput: 2 };
    const f = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
    if (!f) throw new Error('[OllamaProvider] no fetch implementation available');
    this.fetchImpl = f;
  }

  async complete(request: InferenceRequest): Promise<InferenceResult> {
    const body = {
      model: this.model,
      prompt: request.prompt,
      system: request.system,
      stream: false,
      options: request.temperature != null ? { temperature: request.temperature } : undefined
    };
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: request.signal
    });
    if (!res.ok) {
      throw new Error(`[OllamaProvider] ${res.status} ${res.statusText}`);
    }
    const json: any = await res.json();
    const inputTokens = Number(json.prompt_eval_count ?? 0);
    const outputTokens = Number(json.eval_count ?? 0);
    const gccCost =
      (inputTokens / 1e6) * this.pricing.gccPerMInput +
      (outputTokens / 1e6) * this.pricing.gccPerMOutput;
    return {
      text: String(json.response ?? ''),
      usage: { model: this.model, inputTokens, outputTokens, gccCost }
    };
  }
}
