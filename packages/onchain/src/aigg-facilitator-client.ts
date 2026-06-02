/**
 * AiggFacilitatorClient — HTTP client for the AIGG x402 facilitator (node2,
 * sub2api-facilitator). Matches the standard x402 facilitator contract:
 *   GET  /supported            (public)            → capabilities
 *   POST /verify               (Bearer auth)       → no on-chain tx; signature/state check
 *   POST /settle               (Bearer auth)       → real on-chain settlement
 *
 * Request body shape (confirmed from facilitator main.go + sub2api caller):
 *   { "paymentPayload": <x402 PaymentPayload JSON>, "paymentRequirements": <X402PaymentRequirements JSON> }
 *
 * Auth: the facilitator's requireAuth wraps /verify and /settle; the token lives
 * in env (X402_FACILITATOR_AUTH_TOKEN in sub2api; we accept any name). Never goes
 * to the browser — node/server-side only.
 *
 * SAFETY: settle() submits a real Base-mainnet transaction and spends real GCC
 * and ETH gas. Defaults are verify-only; settle() is an explicit method.
 */

export interface AiggFacilitatorClientOptions {
  /** e.g. http://140.143.30.201:18081 (node2). */
  baseUrl: string;
  /** Bearer token gated by the facilitator's requireAuth middleware. */
  authToken: string;
  fetchImpl?: typeof fetch;
}

export interface X402SupportedResponse {
  kinds: Array<{ x402Version: number; scheme: string; network: string }>;
  signers?: Record<string, string[]>;
  extensions?: unknown[];
}

export interface X402VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
  [k: string]: unknown;
}

export interface X402SettleResponse {
  success: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
  errorReason?: string;
  [k: string]: unknown;
}

export interface AiggFacilitatorRequest {
  paymentPayload: unknown;
  paymentRequirements: unknown;
}

export class AiggFacilitatorClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AiggFacilitatorClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.authToken;
    const f = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
    if (!f) throw new Error('[AiggFacilitatorClient] no fetch available');
    this.fetchImpl = f;
  }

  async supported(): Promise<X402SupportedResponse> {
    const res = await this.fetchImpl(`${this.base}/supported`);
    if (!res.ok) throw new Error(`facilitator /supported: ${res.status}`);
    return (await res.json()) as X402SupportedResponse;
  }

  async verify(req: AiggFacilitatorRequest): Promise<X402VerifyResponse> {
    return this.post('/verify', req) as Promise<X402VerifyResponse>;
  }

  /** ⚠️ Real on-chain settlement. Sends a Base-mainnet tx. Uses real GCC + ETH gas. */
  async settle(req: AiggFacilitatorRequest): Promise<X402SettleResponse> {
    return this.post('/settle', req) as Promise<X402SettleResponse>;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`facilitator ${path} ${res.status}: ${text.slice(0, 300)}`);
    try { return JSON.parse(text); } catch { return text; }
  }
}
