/**
 * AiggExecClient — calls ai.gg's POST /api/v1/agents/exec-onchain to either
 * (a) preview a chain action (dry_run:true) or (b) actually settle it. API
 * key authenticated; pairs with AiggIdentityClient's identify() (Phase 1).
 *
 * Today supports two actions:
 *   - topup_gcc   — USDC → GCC via x402 facilitator
 *   - buy_gcc_cca — bid in the CCA continuous-clearing auction
 *
 * Subscription minting (ERC-8257) is intentionally NOT here — see Phase 0
 * spec resolved decisions; it stays guide-only because the user signs that
 * one with their main wallet on the web.
 *
 * Pattern follows AiggIdentityClient: narrow, no retries, no caching;
 * swallows fetch errors and surfaces them as ExecError so callers (the
 * merchant menu) never accidentally leak token material in a stack trace.
 */

/** Common fields every exec response carries. */
export interface ExecResponseBase {
  /** Echo of action + params for menu rendering. */
  action: 'topup_gcc' | 'buy_gcc_cca';
  /** When true, the body is a preview (no on-chain side effect). */
  dry_run: boolean;
  /** Idempotency key, server-echoed (auto-generated when omitted by caller). */
  idempotency_key: string;
  /** Human-readable 1-line summary for the menu confirm screen. */
  human_summary: string;
}

/** Body returned for action=topup_gcc. */
export interface TopupGccResponse extends ExecResponseBase {
  action: 'topup_gcc';
  /** USD amount the user is paying. */
  usdc_amount: string;
  /** Estimated GCC the user will receive (at current spot, dry_run only). */
  estimated_gcc_credit: string;
  /** Atomic settlement tx hash on Base, only present when dry_run=false succeeded. */
  settlement_tx_hash?: `0x${string}`;
  /** New GCC balance after credit (server-side post-settle). */
  credited_gcc_balance?: string;
}

/** Body returned for action=buy_gcc_cca. */
export interface BuyGccCcaResponse extends ExecResponseBase {
  action: 'buy_gcc_cca';
  currency_amount: string;
  max_price_usdc_per_gcc: string;
  /** Estimated GCC the bid would receive if fully filled at max_price. */
  estimated_gcc_if_filled: string;
  /** Bid id on the auction contract, only when dry_run=false. */
  bid_id?: number;
  /** On-chain bid tx hash, only when dry_run=false. */
  tx_hash?: `0x${string}`;
}

export type ExecResponse = TopupGccResponse | BuyGccCcaResponse;

/** Discriminated input shape — keeps each action's params strongly-typed. */
export type ExecRequest =
  | { action: 'topup_gcc'; params: { usdc_amount: string; asset?: 'USDC' } }
  | { action: 'buy_gcc_cca'; params: { currency_amount: string; max_price_usdc_per_gcc: string } };

export interface ExecOptions {
  /** Default: true. Set false ONLY after a player confirmed the preview. */
  dryRun?: boolean;
  /**
   * Stable idempotency key. The server treats two calls with the same key
   * (within a TTL) as one — required for retry safety. When omitted, the
   * client mints a UUIDv4. Surface this back to the caller so a retry can
   * pin the same value.
   */
  idempotencyKey?: string;
}

export class AiggExecError extends Error {
  constructor(
    message: string,
    /** HTTP status code, 0 when the request never landed. */
    public readonly status: number,
    /** Server diagnostic code (e.g. "INVALID_API_KEY", "INSUFFICIENT_USDC"). */
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'AiggExecError';
  }
}

export interface AiggExecClientOptions {
  /** ai.gg base URL — default https://ai.gg */
  baseUrl?: string;
  /** Request timeout ms (default 15000 — settles can be slower than identify). */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Optional UUID provider (default: crypto.randomUUID). */
  newIdempotencyKey?: () => string;
}

export class AiggExecClient {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly newKey: () => string;

  constructor(opts: AiggExecClientOptions = {}) {
    this.base = (opts.baseUrl ?? 'https://ai.gg').replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
    this.newKey = opts.newIdempotencyKey ?? (() => {
      // Prefer crypto.randomUUID when present (Node 19+ / modern browsers)
      const c: { randomUUID?: () => string } | undefined = (globalThis as any).crypto;
      if (c?.randomUUID) return c.randomUUID();
      // Fallback: timestamp + random suffix (no UUID guarantee, but adequate for retry-coalescing)
      return `mud-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    });
  }

  /**
   * Execute (or preview) an on-chain action on behalf of the API-key's user.
   * Returns the server's response body or throws AiggExecError. Never logs
   * the API key, never echoes it in error messages.
   */
  async exec(apiKey: string, req: ExecRequest, opts: ExecOptions = {}): Promise<ExecResponse> {
    if (!apiKey) throw new AiggExecError('apiKey required', 0, 'NO_API_KEY');
    const idempotencyKey = opts.idempotencyKey ?? this.newKey();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.base}/api/v1/agents/exec-onchain`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          action: req.action,
          params: req.params,
          dry_run: opts.dryRun ?? true,
        }),
        signal: controller.signal,
      });
      const env = await res.json().catch(() => ({})) as {
        code?: number | string;
        message?: string;
        data?: ExecResponse;
      };
      if (!res.ok) {
        throw new AiggExecError(
          env.message ?? `exec-onchain ${res.status}`,
          res.status,
          typeof env.code === 'string' ? env.code : undefined,
        );
      }
      if (!env.data) {
        throw new AiggExecError('empty exec-onchain response', res.status, 'EMPTY_BODY');
      }
      return env.data;
    } catch (e) {
      if (e instanceof AiggExecError) throw e;
      throw new AiggExecError(
        e instanceof Error ? e.message : 'exec-onchain failed',
        0,
        'NETWORK_ERROR',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
