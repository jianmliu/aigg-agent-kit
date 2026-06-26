/**
 * RemoteEip3009Settlement — the PRODUCTION settlement: the Go wallet-svc builds &
 * signs the scoped EIP-3009 GCC payment (recipient locked, value capped, key in
 * TEE), this just relays the ready x402 payload to the AIGG facilitator. No key,
 * no typed-data construction, no fund-redirection surface on the TS side.
 *
 * Contrast with X402GccEip3009Settlement (TS builds the payload + signs via a
 * local/dev AgentWallet). Same SettlementStrategy seam.
 */
import type { InferenceUsage, SettlementStrategy, SettlementResult, GccLedger } from '@aigg/npc-agent';
import type { AiggWalletClient } from './aigg-wallet-client';
import type { AiggFacilitatorClient, X402SettleResponse } from './aigg-facilitator-client';

export interface RemoteEip3009SettlementOptions {
  wallet: AiggWalletClient;
  facilitator: AiggFacilitatorClient;
  /** GCC decimals for gccCost → atoms (default 18). */
  decimals?: number;
  ledger?: GccLedger;
  /** verify only (no on-chain tx). Default true for safety. */
  verifyOnly?: boolean;
}

function gccToAtomic(gccCost: number, decimals: number): bigint {
  return BigInt(Math.round(gccCost * 10 ** decimals));
}

export class RemoteEip3009Settlement implements SettlementStrategy {
  constructor(private readonly opts: RemoteEip3009SettlementOptions) {}

  async settle(npcId: string, usage: InferenceUsage): Promise<SettlementResult> {
    const value = gccToAtomic(usage.gccCost ?? 0, this.opts.decimals ?? 18);
    // wallet-svc builds the scoped EIP-3009 typed data, signs it, returns the wire.
    const signed = await this.opts.wallet.signEip3009(npcId, { value });
    const req = { paymentPayload: signed.payload, paymentRequirements: signed.requirements };

    let receiptId: string | undefined;
    if (this.opts.verifyOnly !== false) {
      const v = await this.opts.facilitator.verify(req);
      if (!v.isValid) throw new Error(`facilitator verify rejected: ${v.invalidReason ?? 'unknown'}`);
      receiptId = `verify:${signed.address}`;
    } else {
      const s: X402SettleResponse = await this.opts.facilitator.settle(req);
      if (!s.success) throw new Error(`facilitator settle failed: ${s.errorReason ?? 'unknown'}`);
      receiptId = s.transaction;
    }
    if (this.opts.ledger) await this.opts.ledger.record(npcId, usage);
    return { gccCost: usage.gccCost ?? 0, mode: 'x402', receiptId };
  }
}
