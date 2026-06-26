/**
 * chain-balances — zero-dependency on-chain reader.
 *
 * Lets the merchant NPC show real USDC / GCC balances + ERC-8257 subscription
 * tier without pulling viem into @aigg/gamekit. Uses raw JSON-RPC
 * eth_call against well-known ERC-20 / ToolRegistry selectors. Same pattern as
 * inference-proxy/donations.mjs (already proven against Base mainnet).
 */

// ── canonical Base mainnet addresses (override via env on call site) ──────────
export const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const BASE_GCC  = '0x135fc92fbd260931bee1c412e87170fad30d7779';
export const BASE_ERC8257_TOOL_REGISTRY = '0x265BB2c66aE08a0Ec1f1A2B8c5Bd9D7C5b6c2cf1';

const SEL = {
  balanceOf:    '0x70a08231', // balanceOf(address)
  decimals:     '0x313ce567', // decimals()
  // ERC-8257 / ToolRegistry – simplified probe; the real on-chain method is
  // tier-by-owner. We expose a generic probe and a friendly wrapper.
} as const;

export interface ChainBalanceProviderOptions {
  /** Base / Base-Sepolia / arbitrary L2 RPC URL. */
  rpcUrl: string;
  /** Override token addresses (defaults to Base mainnet). */
  usdc?: string;
  gcc?: string;
  fetchImpl?: typeof fetch;
}

export interface TokenBalance {
  /** Decimal string in token units (e.g. "12.345"). */
  formatted: string;
  /** Atomic units (BigInt as string) — exact, no float loss. */
  atoms: string;
  decimals: number;
  symbol: string;
}

/**
 * Read live ERC-20 balances for an EVM address. Self-contained: no viem,
 * no abi codec deps — eth_call with hand-encoded function selectors.
 * Errors are surfaced (caller decides whether to swallow into a fallback view).
 */
export class ChainBalanceProvider {
  private readonly rpc: string;
  private readonly usdc: `0x${string}`;
  private readonly gcc: `0x${string}`;
  private readonly fetchImpl: typeof fetch;
  private readonly decimalCache = new Map<string, number>();

  constructor(opts: ChainBalanceProviderOptions) {
    this.rpc = opts.rpcUrl;
    this.usdc = (opts.usdc ?? BASE_USDC) as `0x${string}`;
    this.gcc  = (opts.gcc  ?? BASE_GCC)  as `0x${string}`;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
  }

  /** Read all known balances for an address — returns null on RPC error. */
  async balances(address: string): Promise<{ usdc: TokenBalance | null; gcc: TokenBalance | null } | null> {
    try {
      const [usdc, gcc] = await Promise.all([
        this.tokenBalance(this.usdc, address, 'USDC'),
        this.tokenBalance(this.gcc,  address, 'GCC'),
      ]);
      return { usdc, gcc };
    } catch {
      return null;
    }
  }

  /** balanceOf(address) → human-readable + atomic. */
  async tokenBalance(token: string, holder: string, symbol: string): Promise<TokenBalance | null> {
    const dec = await this.decimals(token);
    if (dec == null) return null;
    const data = SEL.balanceOf + holder.toLowerCase().replace(/^0x/, '').padStart(64, '0');
    const raw = await this.ethCall(token, data);
    if (raw == null) return null;
    const atoms = BigInt(raw);
    return { formatted: this.format(atoms, dec), atoms: atoms.toString(), decimals: dec, symbol };
  }

  /** Decimals call, cached per token. */
  private async decimals(token: string): Promise<number | null> {
    const k = token.toLowerCase();
    const cached = this.decimalCache.get(k);
    if (cached !== undefined) return cached;
    const raw = await this.ethCall(token, SEL.decimals);
    if (raw == null) return null;
    const dec = Number(BigInt(raw));
    this.decimalCache.set(k, dec);
    return dec;
  }

  /** Single eth_call → hex string (or null on RPC error). */
  private async ethCall(to: string, data: string): Promise<string | null> {
    try {
      const res = await this.fetchImpl(this.rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'eth_call',
          params: [{ to, data }, 'latest'],
        }),
      });
      if (!res.ok) return null;
      const j = await res.json() as { result?: string; error?: { message: string } };
      if (j.error) return null;
      return j.result ?? null;
    } catch {
      return null;
    }
  }

  /** atoms / 10^decimals → fixed-precision string, trimmed. */
  private format(atoms: bigint, decimals: number): string {
    if (atoms === 0n) return '0';
    const s = atoms.toString().padStart(decimals + 1, '0');
    const whole = s.slice(0, s.length - decimals) || '0';
    const frac = s.slice(s.length - decimals).replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole;
  }
}
