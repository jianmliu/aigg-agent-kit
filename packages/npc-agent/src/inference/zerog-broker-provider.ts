/**
 * ZeroGBrokerProvider — verifiable NPC inference via 0G Compute's DIRECT serving-broker
 * (@0gfoundation/0g-compute-ts-sdk), the TEE-attested path the Router's plain OpenAI
 * surface does not expose. Each response from a TeeML provider is produced inside a TEE
 * and the broker's `processResponse` cryptographically VERIFIES it; we record that verdict
 * in `Attestation.signature` so the oracle's decision is TEE-*verifiable*, not just trusted
 * (closes P3's T2/T3 — the AI oracle was the one trust assumption).
 *
 * Flow (per the 0G docs): createZGComputeNetworkBroker(wallet) → fund ledger (setup) →
 * listService / getServiceMetadata(provider) → acknowledgeProviderSigner(provider) →
 * getRequestHeaders → POST {endpoint}/chat/completions → processResponse(provider, chatID).
 *
 * The broker is injectable (offline-testable); the real path lazy-imports the SDK + ethers
 * (optional deps). Key/RPC via options (env). Ledger funding is a one-time setup, not here.
 */
import type { InferenceProvider, InferenceRequest, InferenceResult, Attestation } from './provider';

/** the broker surface we use (subset of @0gfoundation/0g-compute-ts-sdk). */
export interface ZeroGBroker {
  inference: {
    listService(): Promise<Array<{ provider: string; model?: string; verifiability?: string; serviceType?: string }>>;
    getServiceMetadata(provider: string): Promise<{ endpoint: string; model: string }>;
    acknowledgeProviderSigner(provider: string): Promise<void>;
    getRequestHeaders(provider: string, content?: string): Promise<Record<string, string>>;
    processResponse(provider: string, chatID: string): Promise<boolean>;
  };
  /** prepaid ledger — present on the real SDK broker; used to read the OG balance
   *  that gates metabolism (the on-chain account 0G exposes, unlike ai.gg GCC). */
  ledger?: {
    getLedger(): Promise<{ totalBalance?: bigint | string | number; balance?: bigint | string | number; locked?: bigint | string | number }>;
  };
}

export interface ZeroGBrokerProviderOptions {
  broker: ZeroGBroker;             // created via ZeroGBrokerProvider.fromWallet or injected (tests)
  providerAddress?: string;        // a TeeML provider; if absent, the first TeeML from listService
  fetchImpl?: typeof fetch;
  /** cap the response length (max_tokens) — chatty TeeML models (e.g. GLM-5-FP8)
   *  otherwise ramble for 1000+ tokens; a game NPC wants 1–2 terse lines. Also
   *  bounds the per-call OG cost. Unset = provider default. */
  maxTokens?: number;
}

export interface ZeroGBrokerWalletConfig {
  privateKey: string;              // env only — wallet that owns the (pre-funded) ledger
  rpcUrl?: string;                 // 0G chain RPC (default testnet)
  providerAddress?: string;
  /** cap the response length (max_tokens); see ZeroGBrokerProviderOptions.maxTokens. */
  maxTokens?: number;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await (globalThis.crypto as Crypto).subtle.digest('SHA-256', new TextEncoder().encode(s));
  return '0x' + Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class ZeroGBrokerProvider implements InferenceProvider {
  readonly id = '0g-broker';
  private readonly broker: ZeroGBroker;
  private readonly fetchImpl: typeof fetch;
  private readonly maxTokens?: number;
  private provider?: string;
  private acked = new Set<string>();

  constructor(opts: ZeroGBrokerProviderOptions) {
    this.broker = opts.broker;
    this.provider = opts.providerAddress;
    this.maxTokens = opts.maxTokens;
    const f = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
    if (!f) throw new Error('[ZeroGBrokerProvider] no fetch implementation available');
    this.fetchImpl = f;
  }

  /** Build over @0gfoundation/0g-compute-ts-sdk + ethers (lazy/optional). Ledger must be pre-funded. */
  static async fromWallet(cfg: ZeroGBrokerWalletConfig): Promise<ZeroGBrokerProvider> {
    const { ethers }: any = await import('ethers' as string);
    const { createZGComputeNetworkBroker }: any = await import('@0gfoundation/0g-compute-ts-sdk' as string);
    const rpc = cfg.rpcUrl ?? 'https://evmrpc-testnet.0g.ai';
    const wallet = new ethers.Wallet(cfg.privateKey, new ethers.JsonRpcProvider(rpc));
    const broker = await createZGComputeNetworkBroker(wallet);
    return new ZeroGBrokerProvider({ broker, providerAddress: cfg.providerAddress, maxTokens: cfg.maxTokens });
  }

  /** pick the first TEE (TeeML) provider if none was given. */
  private async ensureProvider(): Promise<string> {
    if (this.provider) return this.provider;
    const services = await this.broker.inference.listService();
    const tee = services.find((s) => (s.verifiability ?? '').toLowerCase().includes('tee'));
    if (!tee) throw new Error('[ZeroGBrokerProvider] no TeeML provider available');
    this.provider = tee.provider;
    return this.provider;
  }

  /**
   * Current prepaid ledger balance in OG (neuron/1e18), or null when the broker
   * doesn't expose a ledger or the read fails. This is 0G's readable on-chain
   * account — feed it to metabolism so NPCs gate on REAL remaining OG (the
   * thing ai.gg's GCC couldn't surface via an API key).
   */
  async ledgerBalanceOG(): Promise<number | null> {
    if (!this.broker.ledger) return null;
    try {
      const l = await this.broker.ledger.getLedger();
      const raw = l.totalBalance ?? l.balance;
      if (raw == null) return null;
      const atoms = typeof raw === 'bigint' ? raw : BigInt(Math.trunc(Number(raw)));
      // OG = atoms / 1e18, kept as a float for the metabolism meter
      return Number(atoms) / 1e18;
    } catch { return null; }
  }

  async complete(request: InferenceRequest): Promise<InferenceResult> {
    const provider = await this.ensureProvider();
    const { endpoint, model } = await this.broker.inference.getServiceMetadata(provider);
    if (!this.acked.has(provider)) { await this.broker.inference.acknowledgeProviderSigner(provider); this.acked.add(provider); }

    const messages: Array<{ role: string; content: string }> = [];
    if (request.system) messages.push({ role: 'system', content: request.system });
    messages.push({ role: 'user', content: request.prompt });

    const headers = await this.broker.inference.getRequestHeaders(provider, request.prompt);
    const res = await this.fetchImpl(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ model, messages, ...(request.temperature != null ? { temperature: request.temperature } : {}), ...(this.maxTokens ? { max_tokens: this.maxTokens } : {}) }),
      signal: request.signal,
    });
    if (!res.ok) throw new Error(`[ZeroGBrokerProvider] HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    const data: any = await res.json();
    const text: string = data?.choices?.[0]?.message?.content ?? '';
    const chatID: string = res.headers.get('ZG-Res-Key') || data?.id || '';

    // ★ verify the TEE signature via the broker (the whole point of the direct path)
    let verified = false;
    if (chatID) { try { verified = await this.broker.inference.processResponse(provider, chatID); } catch { verified = false; } }

    const attestation: Attestation = {
      model,
      promptHash: await sha256Hex(messages.map((m) => `${m.role}:${m.content}`).join('\n')),
      responseHash: await sha256Hex(text),
      // TEE-verified verdict from the broker; absent if not verified
      ...(verified ? { signature: `0g-teeml:verified:${chatID}` } : {}),
    };

    return {
      text,
      usage: { model, inputTokens: Number(data?.usage?.prompt_tokens ?? 0), outputTokens: Number(data?.usage?.completion_tokens ?? 0), gccCost: 0 },
      attestation,
    };
  }
}
