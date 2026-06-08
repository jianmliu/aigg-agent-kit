/**
 * settlement-layer — the VALUE leg: Base stays the canonical asset-settlement
 * layer (Hyperliquid's Arbitrum role), the STF is just execution.
 *
 * Deposits of GCC on Base (into a per-NPC ERC-6551 TBA / a bridge escrow) credit
 * the execution-layer balance; withdrawals debit it and (sequencer-signed)
 * release on Base. `balanceOf` reads the canonical Base balance (the anchor the
 * execution layer must reconcile with). `anchor` posts a domain state root to a
 * Base inbox (challenge window) — the on-chain bridge contract is the
 * own-domain TODO; this seam is interface-first so Base stays the settlement
 * anchor regardless of whether we ever build a bespoke domain.
 *
 * Base compatibility is a TESTED INVARIANT: GCC is conserved (the execution
 * layer can't mint), and the domain balance reconciles with Base balanceOf.
 */
import type { OnchainBalanceProvider } from '../shared-world';

export interface SettlementLayer {
  /** credit execution-layer balance from a Base GCC deposit (= donate/activate into the TBA). */
  deposit(npcId: string, gcc: number): Promise<void>;
  /** debit execution-layer balance + release on Base (sequencer-signed). */
  withdraw(npcId: string, gcc: number): Promise<{ ok: boolean; reason?: string }>;
  /** canonical Base-settled balance (TBA balanceOf) — the reconciliation anchor. */
  balanceOf(npcId: string): Promise<number | null>;
  /** anchor a domain state root to Base (inbox + challenge). On-chain post = TODO. */
  anchor(stateRoot: string): Promise<void>;
}

/**
 * Near-term implementation: execution-layer balances + a Base-custody escrow,
 * with `balanceOf` delegated to the live Base reader (TbaBalanceProvider). The
 * actual on-chain bridge (sequencer-signed withdrawal + challenge) is stubbed
 * (anchors recorded in-memory). Conservation is enforced: every credit increases
 * custody, every release decreases it, so Σ(execution balances) == custody — the
 * execution layer never mints GCC.
 */
export class BaseSettlementLayer implements SettlementLayer {
  private readonly domain = new Map<string, number>();
  private custody = 0; // total GCC held in Base custody (TBAs / bridge escrow)
  private readonly anchors: string[] = [];

  /** baseBalance = the live Base reader (TbaBalanceProvider) for the reconciliation anchor. */
  constructor(private readonly baseBalance?: OnchainBalanceProvider) {}

  async deposit(npcId: string, gcc: number): Promise<void> {
    if (gcc <= 0) return;
    this.custody += gcc;
    this.domain.set(npcId, (this.domain.get(npcId) ?? 0) + gcc);
  }

  async withdraw(npcId: string, gcc: number): Promise<{ ok: boolean; reason?: string }> {
    const bal = this.domain.get(npcId) ?? 0;
    if (gcc <= 0) return { ok: false, reason: 'nonpositive' };
    if (gcc > bal) return { ok: false, reason: 'insufficient' };
    this.domain.set(npcId, bal - gcc);
    this.custody -= gcc; // released from Base custody (the on-chain release is the bridge TODO)
    return { ok: true };
  }

  async balanceOf(npcId: string): Promise<number | null> {
    if (this.baseBalance) {
      const onchain = await this.baseBalance.balanceGcc(npcId);
      if (onchain !== null) return onchain; // Base is canonical
    }
    return this.domain.get(npcId) ?? 0;
  }

  async anchor(stateRoot: string): Promise<void> { this.anchors.push(stateRoot); }

  // ── invariant inspectors (tests / metrics) ─────────────────────────────────
  /** Σ execution-layer balances — must equal {@link custodyTotal} (no minting). */
  domainTotal(): number { return [...this.domain.values()].reduce((a, b) => a + b, 0); }
  /** total GCC held in Base custody. */
  custodyTotal(): number { return this.custody; }
  anchorCount(): number { return this.anchors.length; }
}
