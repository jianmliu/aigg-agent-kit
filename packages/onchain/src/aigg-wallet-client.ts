/**
 * AiggWalletClient — HTTP client for the Go `wallet-svc` (cmd/wallet-svc in the
 * aigg-wallet repo). Lets the TS kit derive per-subject agent EOA addresses and
 * obtain EIP-712 signatures from a service that holds the key (TEE), so no key
 * material ever lives in the TS process.
 *
 *   GET  /healthz
 *   POST /address { subject }            → { address, derivationPath }
 *   POST /sign    { subject, typedData } → { address, signature, digest }
 */
import type { TypedDataPayload } from '@onchainpal/npc-agent';

export interface AiggWalletClientOptions {
  /** wallet-svc base URL, e.g. http://wallet-svc:8091 (server-side network). */
  baseUrl: string;
  /** Bearer token gated by wallet-svc auth. */
  authToken: string;
  fetchImpl?: typeof fetch;
}

export interface DeriveResult {
  address: `0x${string}`;
  derivationPath: string;
}
export interface SignResult {
  address: `0x${string}`;
  signature: `0x${string}`;
  digest: `0x${string}`;
}

export interface Eip3009Params {
  /** GCC atoms (uint256). */
  value: bigint;
  validAfter?: number;
  validBefore?: number;
  nonce?: `0x${string}`;
}
export interface Eip3009Result {
  address: `0x${string}`;
  signature: `0x${string}`;
  digest: `0x${string}`;
  /** ready-to-submit x402 v2 PaymentPayload (the service is the source of truth). */
  payload: unknown;
  /** matching x402 PaymentRequirements. */
  requirements: unknown;
}

export class AiggWalletClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AiggWalletClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.authToken;
    const f = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
    if (!f) throw new Error('[AiggWalletClient] no fetch available');
    this.fetchImpl = f;
  }

  async address(subject: string): Promise<DeriveResult> {
    return this.post('/address', { subject }) as Promise<DeriveResult>;
  }

  async sign(subject: string, typedData: TypedDataPayload): Promise<SignResult> {
    return this.post('/sign', { subject, typedData }) as Promise<SignResult>;
  }

  /**
   * Scoped GCC payment signature (production path). The service builds the
   * EIP-3009 typed data from its fixed config (token/payTo/chain) and signs;
   * recipient is locked server-side. Returns the ready x402 payload + requirements.
   */
  async signEip3009(subject: string, p: Eip3009Params): Promise<Eip3009Result> {
    return this.post('/sign/eip3009', { subject, ...p }) as Promise<Eip3009Result>;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      // EIP-712 message values are bigints; wallet-svc (go-ethereum apitypes)
      // expects uint256 as decimal strings, so serialize bigint → string.
      body: JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`wallet-svc ${path} ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }
}
