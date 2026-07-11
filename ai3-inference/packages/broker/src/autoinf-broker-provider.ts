/**
 * AutoInfBrokerProvider — verifiable NPC inference through the Auto EVM provider
 * market (aigg-src), the mirror of ZeroGBrokerProvider for the AI3-denominated
 * marketplace. It satisfies the same InferenceProvider seam, so 0gtown / mud-demo
 * consume it with zero host changes: an NPC picks between 0G TeeML (open weights)
 * and this market (closed models, TEE-verified *relay*) by price list.
 *
 * This is the Phase-A **verify-only** build (spec §6, §9 Phase A → Phase C):
 *   • read the on-chain ServiceRegistry → pick a service by model/price;
 *   • verify the provider's dstack quote ONCE (DSN blob + report_data binding);
 *   • per response: recompute the digest, ECDSA-verify against attestedSigner,
 *     stamp attestation.signature = "dstack:verified:<id>" (never fabricated);
 *   • fill usage cost from registry prices (the withLedgerCost lesson — not 0).
 *
 * NOT here (Phase B): per-request EIP-712 vouchers + on-chain settlement. Payment
 * stays on the existing rails; this build proves provenance, not billing.
 *
 * Honest boundary (spec §7): a verified response is "TEE-verified relay", NOT
 * "…inference" — for closed models the enclave attests faithful relay, not the
 * upstream weights.
 */
import { keccak256, stringToBytes, getAddress, createPublicClient, http, type Address, type Hex } from 'viem';
import type { InferenceProvider, InferenceRequest, InferenceResult, Attestation } from '@ai3-inference/core';
import {
  AutoInfAttestationVerifier,
  recoverResponsePublicKey,
  parseAttestationHeaders,
  UNSAFE_acceptAnyQuote,
  type QuoteVerifier,
  type ResponseAttestation,
} from '@ai3-inference/verify';

/** A ServiceRegistry listing, decoded from the on-chain struct. */
export interface RegistryService {
  provider: Address;
  endpoint: string;
  models: string[];
  inputPriceWei: bigint;
  outputPriceWei: bigint;
  attestationRef: Hex;
  attestedSigner: Address;
  verifiability: string;
  active: boolean;
}

/** Reads listings from the ServiceRegistry (injectable → offline-testable). */
export interface RegistryReader {
  list(): Promise<RegistryService[]>;
}

/** Fetches a quote blob from DSN by its attestationRef (keccak of the blob). */
export interface QuoteFetcher {
  fetch(attestationRef: Hex): Promise<Uint8Array>;
}

export interface AutoInfBrokerProviderOptions {
  registry: RegistryReader;
  quotes: QuoteFetcher;
  /** TDX/DCAP quote verifier. When omitted: degrades to UNSAFE_acceptAnyQuote
   *  WITH a warning — unless requireVerified is set, in which case omitting it
   *  is a hard construction error. A production deployment MUST pass a real
   *  one (see @ai3-inference/verify's DCAP adapters). */
  quoteVerifier?: QuoteVerifier;
  /** preferred model; if unset, the request has none, or several match, the
   *  cheapest active service (by input price) wins. */
  model?: string;
  /** pin a specific provider address instead of price-picking. */
  providerAddress?: string;
  fetchImpl?: typeof fetch;
  /** cap response length (max_tokens); mirrors ZeroGBrokerProvider. */
  maxTokens?: number;
  /** when true, complete() THROWS if a response can't be verified (no signer
   *  match, missing attestation, quote failure). Default false: degrade to an
   *  unsigned attestation, same as the 0G path when a verdict is unavailable.
   *  Requires an explicit quoteVerifier: promising "verified" with no quote
   *  verifier is a contradiction and fails at construction (plan T5). */
  requireVerified?: boolean;
  /** neuron→AI3 scale for reporting cost (default 1e18). */
  weiPerAI3?: number;
}

interface ChosenService {
  svc: RegistryService;
  verifier: AutoInfAttestationVerifier;
}

export class AutoInfBrokerProvider implements InferenceProvider {
  readonly id = 'autoinf-broker';
  private readonly registry: RegistryReader;
  private readonly quotes: QuoteFetcher;
  private readonly quoteVerifier: QuoteVerifier;
  private readonly fetchImpl: typeof fetch;
  private readonly preferredModel?: string;
  private readonly pinnedProvider?: string;
  private readonly maxTokens?: number;
  private readonly requireVerified: boolean;
  private readonly weiPerAI3: number;
  private chosen?: ChosenService;

  constructor(opts: AutoInfBrokerProviderOptions) {
    this.registry = opts.registry;
    this.quotes = opts.quotes;
    if (!opts.quoteVerifier) {
      if (opts.requireVerified) {
        throw new Error(
          '[AutoInfBrokerProvider] requireVerified:true needs a quoteVerifier — ' +
            'provide a DCAP verifier (or explicitly opt out with UNSAFE_acceptAnyQuote)',
        );
      }
      console.warn(
        '[AutoInfBrokerProvider] no quoteVerifier — using UNSAFE_acceptAnyQuote; ' +
          'the TDX hardware root is NOT checked. Provide a DCAP verifier in production.',
      );
    }
    this.quoteVerifier = opts.quoteVerifier ?? UNSAFE_acceptAnyQuote;
    const f = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
    if (!f) throw new Error('[AutoInfBrokerProvider] no fetch implementation available');
    this.fetchImpl = f;
    this.preferredModel = opts.model;
    this.pinnedProvider = opts.providerAddress ? getAddress(opts.providerAddress) : undefined;
    this.maxTokens = opts.maxTokens;
    this.requireVerified = opts.requireVerified ?? false;
    this.weiPerAI3 = opts.weiPerAI3 ?? 1e18;
  }

  /** the resolved provider address (after the first complete()/ensureService). */
  get providerAddress(): string | undefined {
    return this.chosen?.svc.provider;
  }

  private async ensureService(model?: string): Promise<ChosenService> {
    if (this.chosen) return this.chosen;
    const wanted = model ?? this.preferredModel;
    const services = (await this.registry.list()).filter((s) => s.active);
    if (services.length === 0) throw new Error('[AutoInfBrokerProvider] registry has no active services');

    let pool = services;
    if (this.pinnedProvider) {
      pool = services.filter((s) => getAddress(s.provider) === this.pinnedProvider);
      if (pool.length === 0) throw new Error(`[AutoInfBrokerProvider] pinned provider ${this.pinnedProvider} not listed/active`);
    }
    if (wanted) {
      const byModel = pool.filter((s) => s.models.includes(wanted));
      if (byModel.length > 0) pool = byModel;
      else if (this.preferredModel) {
        throw new Error(`[AutoInfBrokerProvider] no active service offers model ${wanted}`);
      }
    }
    // cheapest by input price (stable: ties keep registry order).
    const svc = pool.reduce((best, s) => (s.inputPriceWei < best.inputPriceWei ? s : best), pool[0]);

    const verifier = new AutoInfAttestationVerifier({
      attestedSigner: svc.attestedSigner,
      attestationRef: svc.attestationRef,
      quoteVerifier: this.quoteVerifier,
      // the registry's claimed label is re-checked against the imageHash→tier
      // allowlist inside verifyQuoteOnce — a lying label fails verification.
      verifiability: svc.verifiability,
    });
    this.chosen = { svc, verifier };
    return this.chosen;
  }

  async complete(request: InferenceRequest): Promise<InferenceResult> {
    const modelHint = this.preferredModel;
    const { svc, verifier } = await this.ensureService(modelHint);

    const messages: Array<{ role: string; content: string }> = [];
    if (request.system) messages.push({ role: 'system', content: request.system });
    messages.push({ role: 'user', content: request.prompt });

    // Serialize ONCE: the exact bytes we POST are the bytes we hash, so the
    // client's reqHash matches the gateway's keccak(request body).
    const model = modelHint ?? svc.models[0] ?? '';
    const body = JSON.stringify({
      model,
      messages,
      ...(request.temperature != null ? { temperature: request.temperature } : {}),
      ...(this.maxTokens ? { max_tokens: this.maxTokens } : {}),
    });
    const requestHash = keccak256(stringToBytes(body));

    const res = await this.fetchImpl(`${svc.endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: request.signal,
    });
    // Read the RAW response bytes before parsing so responseHash matches the
    // gateway's keccak(response body) exactly.
    const rawText = await res.text();
    if (!res.ok) throw new Error(`[AutoInfBrokerProvider] HTTP ${res.status}: ${rawText}`);
    const responseHash = keccak256(stringToBytes(rawText));

    let data: any;
    try {
      data = JSON.parse(rawText);
    } catch {
      throw new Error('[AutoInfBrokerProvider] non-JSON response body');
    }
    const text: string = data?.choices?.[0]?.message?.content ?? '';
    const inputTokens = Number(data?.usage?.prompt_tokens ?? 0);
    const outputTokens = Number(data?.usage?.completion_tokens ?? 0);

    // ── verification ──────────────────────────────────────────────────────────
    const att = parseAttestationHeaders(res.headers, requestHash, responseHash);
    let signature: string | undefined;
    if (att) {
      const verdict = await this.verifyAttestation(verifier, svc, att);
      if (verdict) signature = verdict;
    }
    if (!signature && this.requireVerified) {
      throw new Error('[AutoInfBrokerProvider] response could not be verified (requireVerified)');
    }

    const costWei = svc.inputPriceWei * BigInt(inputTokens) + svc.outputPriceWei * BigInt(outputTokens);
    const attestation: Attestation = {
      model,
      promptHash: requestHash,
      responseHash,
      ...(signature ? { signature, signedAt: Date.now() } : {}),
    };

    return {
      text,
      usage: {
        model,
        inputTokens,
        outputTokens,
        // report the AI3 cost from registry prices — never 0 when priced.
        gccCost: Number(costWei) / this.weiPerAI3,
      },
      attestation,
    };
  }

  /** verify the quote once, then the per-response signature. Returns the honest
   *  verdict token on success, undefined otherwise (never throws — verification
   *  failure degrades gracefully unless requireVerified upstream). */
  private async verifyAttestation(
    verifier: AutoInfAttestationVerifier,
    svc: RegistryService,
    att: ResponseAttestation,
  ): Promise<string | undefined> {
    try {
      const pubkey = await recoverResponsePublicKey(att);
      const blob = await this.quotes.fetch(svc.attestationRef);
      await verifier.verifyQuoteOnce(blob, pubkey);
      const v = await verifier.verifyResponse(att);
      return v.verified ? v.token : undefined;
    } catch (e) {
      console.warn('[AutoInfBrokerProvider] attestation verify failed:', e instanceof Error ? e.message : e);
      return undefined;
    }
  }
}

// ── production adapters ───────────────────────────────────────────────────────

/** ServiceRegistry.list(offset,limit) view ABI (matches the Solidity struct). */
const SERVICE_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'list',
    stateMutability: 'view',
    inputs: [
      { name: 'offset', type: 'uint256' },
      { name: 'limit', type: 'uint256' },
    ],
    outputs: [
      { name: 'addrs', type: 'address[]' },
      {
        name: 'svcs',
        type: 'tuple[]',
        components: [
          { name: 'endpoint', type: 'string' },
          { name: 'models', type: 'string[]' },
          { name: 'inputPriceWei', type: 'uint256' },
          { name: 'outputPriceWei', type: 'uint256' },
          { name: 'attestationRef', type: 'bytes32' },
          { name: 'attestedSigner', type: 'address' },
          { name: 'verifiability', type: 'string' },
          { name: 'updatedAt', type: 'uint64' },
          { name: 'active', type: 'bool' },
        ],
      },
    ],
  },
] as const;

/** ViemRegistryReader reads the ServiceRegistry over an Auto EVM RPC, paging
 *  through list(). Provider addresses run in parallel with their structs. */
export class ViemRegistryReader implements RegistryReader {
  private readonly client: ReturnType<typeof createPublicClient>;
  private readonly address: Address;
  private readonly pageSize: bigint;

  constructor(rpcUrl: string, registryAddress: string, pageSize = 100) {
    this.client = createPublicClient({ transport: http(rpcUrl) });
    this.address = getAddress(registryAddress);
    this.pageSize = BigInt(pageSize);
  }

  async list(): Promise<RegistryService[]> {
    const out: RegistryService[] = [];
    for (let offset = 0n; ; offset += this.pageSize) {
      const [addrs, svcs] = (await this.client.readContract({
        address: this.address,
        abi: SERVICE_REGISTRY_ABI,
        functionName: 'list',
        args: [offset, this.pageSize],
      })) as readonly [readonly Address[], readonly any[]];
      for (let i = 0; i < addrs.length; i++) {
        const s = svcs[i];
        out.push({
          provider: getAddress(addrs[i]),
          endpoint: s.endpoint,
          models: [...s.models],
          inputPriceWei: BigInt(s.inputPriceWei),
          outputPriceWei: BigInt(s.outputPriceWei),
          attestationRef: s.attestationRef as Hex,
          attestedSigner: getAddress(s.attestedSigner),
          verifiability: s.verifiability,
          active: Boolean(s.active),
        });
      }
      if (addrs.length < Number(this.pageSize)) break;
    }
    return out;
  }
}

/** HttpQuoteFetcher fetches a quote blob from a DSN HTTP gateway. The URL for a
 *  ref defaults to `${base}/<refHex-no-0x>`; override for other gateway shapes. */
export class HttpQuoteFetcher implements QuoteFetcher {
  private readonly urlForRef: (ref: Hex) => string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, opts: { urlForRef?: (ref: Hex) => string; fetchImpl?: typeof fetch } = {}) {
    const trimmed = baseUrl.replace(/\/$/, '');
    this.urlForRef = opts.urlForRef ?? ((ref) => `${trimmed}/${ref.slice(2)}`);
    const f = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
    if (!f) throw new Error('[HttpQuoteFetcher] no fetch implementation available');
    this.fetchImpl = f;
  }

  async fetch(attestationRef: Hex): Promise<Uint8Array> {
    const res = await this.fetchImpl(this.urlForRef(attestationRef));
    if (!res.ok) throw new Error(`[HttpQuoteFetcher] DSN GET ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

/** Config for AutoInfBrokerProvider.fromRpc — the production wiring. */
export interface AutoInfBrokerRpcConfig {
  rpcUrl: string;              // Auto EVM JSON-RPC
  registryAddress: string;    // ServiceRegistry contract
  dsnBaseUrl: string;         // DSN read gateway for quote blobs
  quoteVerifier?: QuoteVerifier;
  model?: string;
  providerAddress?: string;
  maxTokens?: number;
  requireVerified?: boolean;
  fetchImpl?: typeof fetch;
}

/** fromRpc builds the provider against a live Auto EVM RPC + DSN gateway. */
export function autoInfBrokerFromRpc(cfg: AutoInfBrokerRpcConfig): AutoInfBrokerProvider {
  return new AutoInfBrokerProvider({
    registry: new ViemRegistryReader(cfg.rpcUrl, cfg.registryAddress),
    quotes: new HttpQuoteFetcher(cfg.dsnBaseUrl, { fetchImpl: cfg.fetchImpl }),
    quoteVerifier: cfg.quoteVerifier,
    model: cfg.model,
    providerAddress: cfg.providerAddress,
    maxTokens: cfg.maxTokens,
    requireVerified: cfg.requireVerified,
    fetchImpl: cfg.fetchImpl,
  });
}
