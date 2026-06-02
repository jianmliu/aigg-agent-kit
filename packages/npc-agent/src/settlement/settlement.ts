import type { InferenceUsage } from '../inference/provider';
import { GccLedger } from '../economy/gcc-ledger';

/**
 * SettlementStrategy — how an NPC's GCC consumption is settled. Separates METERING
 * (always, per-call, via GccLedger) from SETTLEMENT (policy: ledger-only vs real
 * on-chain x402 payment). The brain/runtime calls `settle` after each inference.
 *
 * - LedgerSettlement (demo default): record to the per-NPC ledger. The actual GCC
 *   is already billed by the AIGG gateway when inference ran through ai.gg, and
 *   funding is one AIGG account — so the ledger IS the demo's settlement record.
 * - X402GccSettlement (game-engine, post-demo): sign a GCC EIP-2612/Permit2 payment
 *   via the NPC's AgentWallet and submit to the AIGG facilitator (real on-chain).
 */
export interface SettlementResult {
  /** GCC charged for this inference (atomic-ish / display units, mirrors usage.gccCost). */
  gccCost: number;
  /** settlement mode used. */
  mode: 'ledger' | 'x402';
  /** facilitator/tx receipt id, if a real on-chain settlement happened. */
  receiptId?: string;
}

export interface SettlementStrategy {
  settle(npcId: string, usage: InferenceUsage): Promise<SettlementResult>;
}

/** Ledger-only settlement (demo). Records consumption; no on-chain payment. */
export class LedgerSettlement implements SettlementStrategy {
  constructor(private readonly ledger: GccLedger) {}

  async settle(npcId: string, usage: InferenceUsage): Promise<SettlementResult> {
    await this.ledger.record(npcId, usage);
    return { gccCost: usage.gccCost ?? 0, mode: 'ledger' };
  }
}
