/**
 * ZeroGComputeProvider — an InferenceProvider backed by the 0G Compute Network via its
 * Router (an OpenAI-compatible API gateway: one endpoint, one API key, on-chain billing,
 * provider discovery + failover). Lets an NPC's reasoning run on 0G Compute's TEE GPUs
 * instead of a local model — closing the stack on 0G (chain + storage + compute).
 *
 * Verifiability: 0G Compute providers can run in TEE mode ("TeeML" — Intel TDX + NVIDIA
 * H100/H200), signing each response with a TEE key whose provenance is attested (remote
 * attestation). When the Router surfaces that signature/RA on a response, we carry it in
 * `Attestation.signature`, turning the oracle's output from *trusted* into *TEE-verifiable*
 * (strengthens the threat model's T2/T3). The exact field/header the Router exposes is
 * captured best-effort; `[TODO: confirm the Router's attestation surface vs the direct
 * serving-broker TeeML path]`.
 *
 * Key/endpoint via options (env in practice) — never inline.
 */
import type { InferenceProvider, InferenceRequest, InferenceResult, Attestation } from './provider';

/** Default Router base URLs (OpenAI-compatible `/v1`). */
export const ZEROG_ROUTER_TESTNET = 'https://router-api-testnet.integratenetwork.work/v1';
export const ZEROG_ROUTER_MAINNET = 'https://router-api.0g.ai/v1';

export interface ZeroGComputeProviderOptions {
  /** 0G Router API key (env only). */
  apiKey: string;
  /** model id the Router exposes (e.g. a hosted LLM). */
  model: string;
  /** Router base URL (default: testnet). */
  baseUrl?: string;
  /** capture the TEE attestation/signature from the response when present (default true). */
  attest?: boolean;
  fetchImpl?: typeof fetch;
}

async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const buf = await (globalThis.crypto as Crypto).subtle.digest('SHA-256', data);
  return '0x' + Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class ZeroGComputeProvider implements InferenceProvider {
  readonly id: string;
  private readonly base: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly attest: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ZeroGComputeProviderOptions) {
    if (!opts.apiKey) throw new Error('[ZeroGComputeProvider] apiKey required (env, not inline)');
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.base = (opts.baseUrl ?? ZEROG_ROUTER_TESTNET).replace(/\/$/, '');
    this.attest = opts.attest ?? true;
    this.id = `0g-compute:${opts.model}`;
    const f = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
    if (!f) throw new Error('[ZeroGComputeProvider] no fetch implementation available');
    this.fetchImpl = f;
  }

  async complete(request: InferenceRequest): Promise<InferenceResult> {
    const messages: Array<{ role: string; content: string }> = [];
    if (request.system) messages.push({ role: 'system', content: request.system });
    messages.push({ role: 'user', content: request.prompt });

    const res = await this.fetchImpl(`${this.base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages,
        ...(request.temperature != null ? { temperature: request.temperature } : {}),
        stream: false,
      }),
      signal: request.signal,
    });
    if (!res.ok) throw new Error(`[ZeroGComputeProvider] HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    const json: any = await res.json();
    const text: string = json?.choices?.[0]?.message?.content ?? '';

    const usage = {
      model: this.model,
      inputTokens: Number(json?.usage?.prompt_tokens ?? 0),
      outputTokens: Number(json?.usage?.completion_tokens ?? 0),
      gccCost: 0, // 0G Compute settles its own micropayment on-chain via the Router
    };

    let attestation: Attestation | undefined;
    if (this.attest) {
      // best-effort capture of the TEE signature / RA the Router may surface
      const sig: string | undefined =
        json?.verification?.signature ?? json?.tee?.signature ?? res.headers.get('x-tee-signature') ?? undefined;
      attestation = {
        model: this.model,
        promptHash: await sha256Hex(messages.map((m) => `${m.role}:${m.content}`).join('\n')),
        responseHash: await sha256Hex(text),
        ...(sig ? { signature: sig } : {}),
      };
    }

    return { text, usage, ...(attestation ? { attestation } : {}) };
  }
}
