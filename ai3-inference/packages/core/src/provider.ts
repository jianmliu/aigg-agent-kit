/**
 * InferenceProvider — the seam over "where the LLM runs". Canonical home of
 * these types (moved from aigg-agent-kit packages/npc-agent per extraction
 * plan T3; the kit re-exports from here as of T4).
 *
 * The provider is also where onchain provenance originates: a hosted provider
 * can return an Attestation (signed hash of prompt+response+model) so a later
 * onchain settlement can prove which model produced the reasoning behind a
 * delta.
 */
export interface InferenceRequest {
  prompt: string;
  system?: string;
  temperature?: number;
  /**
   * JSON Schema for the expected structured output. Providers that support
   * constrained decoding use it; others ignore it and callers validate after.
   */
  responseSchema?: unknown;
  signal?: AbortSignal;
}

export interface Attestation {
  model: string;
  promptHash: string;
  responseHash: string;
  /** present only for providers that sign (hosted); absent for local dev. */
  signature?: string;
  signedAt?: number;
}

/**
 * InferenceUsage — the metering output of a single inference. The provider
 * ONLY meters (computes gccCost); it does NOT pay. Settlement consumes this
 * to micro-pay from the agent's wallet.
 */
export interface InferenceUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** cost in GCC for this call (tokens × per-model multiplier). */
  gccCost: number;
}

export interface InferenceResult {
  text: string;
  usage?: InferenceUsage;
  attestation?: Attestation;
}

export interface InferenceProvider {
  readonly id: string;
  complete(request: InferenceRequest): Promise<InferenceResult>;
}
