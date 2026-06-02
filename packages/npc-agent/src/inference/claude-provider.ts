import Anthropic from '@anthropic-ai/sdk';
import type { InferenceProvider, InferenceRequest, InferenceResult } from './provider';

export interface ClaudeProviderOptions {
  model?: string;
  apiKey?: string;
  /** inject a pre-built client (e.g. AnthropicAWS) instead of the default. */
  client?: Anthropic;
  maxTokens?: number;
  /** effort tier. NPC ambient lines are simple → 'low' by default. */
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** 'disabled' for lowest latency on simple chatter; 'adaptive' to let Claude think. */
  thinking?: 'adaptive' | 'disabled';
  /** GCC cost = tokens × these per-million multipliers (mirror your gcc_pricing.json). */
  pricing?: { gccPerMInput: number; gccPerMOutput: number };
}

const DEFAULT_MODEL = 'claude-opus-4-8';

/**
 * ClaudeProvider — a direct Anthropic-API inference provider behind the same
 * InferenceProvider seam as OllamaProvider / (future) AiggProvider. Used to
 * "call Claude directly" for dev and for offline tooling (e.g. card generation),
 * ahead of routing NPC inference through AIGG/GCC.
 *
 * Notes (Opus 4.8 surface):
 * - temperature/top_p/top_k are intentionally NOT forwarded (Opus 4.8 returns 400
 *   if any are sent) — steer via prompt instead.
 * - thinking is adaptive (budget_tokens is removed); set 'disabled' for latency.
 * - the system prompt is cached (cache_control) so a stable persona prefix is reused.
 * Still meters usage {tokens, gccCost} like every provider — settlement is separate.
 */
export class ClaudeProvider implements InferenceProvider {
  readonly id = 'claude';
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly effort: 'low' | 'medium' | 'high' | 'max';
  private readonly thinking: 'adaptive' | 'disabled';
  private readonly pricing: { gccPerMInput: number; gccPerMOutput: number };

  constructor(opts: ClaudeProviderOptions = {}) {
    this.client = opts.client ?? new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
    this.model = opts.model ?? DEFAULT_MODEL;
    this.maxTokens = opts.maxTokens ?? 2048;
    this.effort = opts.effort ?? 'low';
    this.thinking = opts.thinking ?? 'adaptive';
    this.pricing = opts.pricing ?? { gccPerMInput: 5, gccPerMOutput: 25 };
  }

  async complete(request: InferenceRequest): Promise<InferenceResult> {
    const system = request.system
      ? [{ type: 'text' as const, text: request.system, cache_control: { type: 'ephemeral' as const } }]
      : undefined;

    const message = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: this.maxTokens,
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: request.prompt }],
        thinking: { type: this.thinking },
        output_config: { effort: this.effort }
      },
      request.signal ? { signal: request.signal } : undefined
    );

    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const u = message.usage;
    const inputTokens =
      u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const outputTokens = u.output_tokens;
    const gccCost =
      (inputTokens / 1e6) * this.pricing.gccPerMInput + (outputTokens / 1e6) * this.pricing.gccPerMOutput;

    return { text, usage: { model: this.model, inputTokens, outputTokens, gccCost } };
  }
}
