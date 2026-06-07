/**
 * AiggWalletClient — HTTP client for the Go `wallet-svc` (cmd/wallet-svc in the
 * aigg-wallet repo). Lets the TS kit derive per-agent EOA addresses and obtain
 * EIP-712 signatures from a service that holds the key (TEE), so no key material
 * ever lives in the TS process.
 *
 *   POST /address       <selector>              → { address, derivationPath }
 *   POST /sign          <selector> + typedData  → { address, signature, digest }
 *   POST /sign/eip3009  <selector> + value/...  → { address, signature, payload, requirements }
 *
 * <selector> is one of (see wallet-svc keySelector):
 *   - `string`            → { subject } legacy keccak(subject) account (back-compat)
 *   - `{ owner, agent }`  → structured m/44'/coin'/owner'/agent' (owner=aigg userID,
 *                           agent=npcIndex) — the one-owner-many-agents model
 *   - `{ path: number[] }`→ explicit all-hardened path
 */
import type { TypedDataPayload } from '@onchainpal/npc-agent';

/**
 * KeySelector mirrors the wallet-svc `keySelector`. A bare string is the legacy
 * keccak(subject) scheme; `{ owner, agent }` is the structured model (owner =
 * the aigg-src userID that owns the agents, agent = a stable per-NPC index);
 * `{ path }` is a fully explicit all-hardened BIP-44 path.
 */
export type KeySelector =
  | string
  | { owner: number; agent: number }
  | { path: number[] };

/** Serialize a selector into the wallet-svc request body shape. */
export function selectorBody(sel: KeySelector): Record<string, unknown> {
  return typeof sel === 'string' ? { subject: sel } : { ...sel };
}

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

/** Params for /sign/tx — an arbitrary EIP-1559 tx signed with the selected key. */
export interface SignTxParams {
  chainId: number;
  nonce: number;
  to: `0x${string}`;
  /** hex calldata (0x... ). */
  data: `0x${string}`;
  /** wei (default 0n). */
  value?: bigint;
  gas: bigint;
  gasTipCap: bigint;
  gasFeeCap: bigint;
}
export interface SignTxResult {
  rawSignedTx: `0x${string}`;
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

  /** Resolve an agent EOA address. `sel` is an npcId string (legacy) or a
   *  structured `{ owner, agent }` / `{ path }` selector. */
  async address(sel: KeySelector): Promise<DeriveResult> {
    return this.post('/address', selectorBody(sel)) as Promise<DeriveResult>;
  }

  async sign(sel: KeySelector, typedData: TypedDataPayload): Promise<SignResult> {
    return this.post('/sign', { ...selectorBody(sel), typedData }) as Promise<SignResult>;
  }

  /**
   * Scoped GCC payment signature (production path). The service builds the
   * EIP-3009 typed data from its fixed config (token/payTo/chain) and signs;
   * recipient is locked server-side. Returns the ready x402 payload + requirements.
   *
   * `sel` selects the signing key: an npcId string (legacy keccak) or the
   * structured `{ owner: aiggUserId, agent: npcIndex }`.
   */
  async signEip3009(sel: KeySelector, p: Eip3009Params): Promise<Eip3009Result> {
    return this.post('/sign/eip3009', { ...selectorBody(sel), ...p }) as Promise<Eip3009Result>;
  }

  /**
   * Sign an arbitrary EIP-1559 tx with the selected key (the caller builds
   * calldata/nonce/gas and broadcasts the returned rawSignedTx). POWERFUL — the
   * caller is the trusted policy layer (decides to/data/value). Used by
   * RemoteNpcMinter so the minter/treasury key lives in wallet-svc, never in the
   * mud-server process. Returns the raw signed tx hex to broadcast.
   */
  async signTx(sel: KeySelector, p: SignTxParams): Promise<SignTxResult> {
    return this.post('/sign/tx', {
      ...selectorBody(sel),
      chainID: p.chainId,
      nonce: p.nonce,
      to: p.to,
      data: p.data,
      value: (p.value ?? 0n).toString(),
      gas: Number(p.gas),
      gasTipCap: p.gasTipCap.toString(),
      gasFeeCap: p.gasFeeCap.toString(),
    }) as Promise<SignTxResult>;
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
