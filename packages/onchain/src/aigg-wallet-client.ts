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
