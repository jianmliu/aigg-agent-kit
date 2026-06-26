/**
 * X402GccSettlement — real on-chain GCC settlement for an NPC's thinking.
 *
 * Per AIGG's x402-permit2-agent-wallet design: GCC is paid via its native
 * **EIP-2612 `permit()`** (GCC.sol is ERC20Permit). The NPC's per-NPC AgentWallet
 * (its EOA) signs the EIP-712 Permit payload; the payment is submitted to the
 * aigg-facilitator, which calls `permit()` + `transferFrom` on-chain.
 *
 * Dependencies that are AIGG-side / require a live chain (so injected here):
 *  - nonceProvider: reads `GCC.nonces(owner)` (RPC) — fake in tests.
 *  - facilitator: submits the signed payment (HTTP to aigg-facilitator) — fake in tests.
 * This makes the typed-data construction + signing headless-testable; point the
 * real impls at chain/facilitator to settle for real.
 *
 * Service-side only (uses the AgentWallet's key path); not in the browser bundle.
 */
import type { AgentWallet, InferenceUsage, SettlementStrategy, SettlementResult, GccLedger, TypedDataPayload } from '@aigg/npc-agent';

export interface GccSettlementConfig {
  /** GCC ERC-20 contract address (Base). */
  gccToken: `0x${string}`;
  /** GCC token name() for the EIP-712 domain, e.g. "Guaranteed Capacity Credit". */
  gccName: string;
  /** AIGG seller / spender address that receives the GCC. */
  sellerAddress: `0x${string}`;
  chainId: number;
  /** GCC decimals (default 18). */
  decimals?: number;
  /** seconds until the permit deadline. */
  timeoutSeconds?: number;
}

/** Reads GCC.nonces(owner) — real impl hits an RPC; fake returns a fixed nonce. */
export interface NonceProvider {
  nonce(owner: string): Promise<bigint>;
}

/** Submits the signed x402 payment to the aigg-facilitator. */
export interface FacilitatorClient {
  submit(payment: GccPermitPayment): Promise<{ receiptId: string }>;
}

export interface GccPermitPayment {
  scheme: 'eip2612';
  chainId: number;
  token: `0x${string}`;
  owner: string;
  spender: `0x${string}`;
  value: string; // atomic, decimal string
  nonce: string;
  deadline: number;
  signature: `0x${string}`;
}

function gccToAtomic(gccCost: number, decimals: number): bigint {
  // gccCost is a small display amount; scale to atomic units.
  return BigInt(Math.round(gccCost * 10 ** decimals));
}

export interface X402GccSettlementOptions {
  config: GccSettlementConfig;
  /** resolve the per-NPC AgentWallet (its EOA signer). */
  walletFor: (npcId: string) => AgentWallet;
  nonceProvider: NonceProvider;
  facilitator: FacilitatorClient;
  /** record consumption to the per-NPC ledger as well (mirrors LedgerSettlement). */
  ledger?: GccLedger;
  now?: () => number;
}

export class X402GccSettlement implements SettlementStrategy {
  constructor(private readonly opts: X402GccSettlementOptions) {}

  /** the GCC EIP-2612 Permit EIP-712 payload (exact shape per AIGG spec §3.1.2). */
  buildPermitTypedData(owner: string, value: bigint, nonce: bigint, deadline: number): TypedDataPayload {
    const { gccName, gccToken, chainId, sellerAddress } = this.opts.config;
    return {
      domain: { name: gccName, version: '1', chainId, verifyingContract: gccToken },
      types: {
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' }
        ]
      },
      primaryType: 'Permit',
      message: { owner, spender: sellerAddress, value, nonce, deadline }
    };
  }

  async settle(npcId: string, usage: InferenceUsage): Promise<SettlementResult> {
    const cfg = this.opts.config;
    const decimals = cfg.decimals ?? 18;
    const wallet = this.opts.walletFor(npcId);
    const owner = wallet.address;
    const value = gccToAtomic(usage.gccCost ?? 0, decimals);
    const nonce = await this.opts.nonceProvider.nonce(owner);
    const now = this.opts.now ? this.opts.now() : Math.floor(Date.now() / 1000);
    const deadline = now + (cfg.timeoutSeconds ?? 300);

    const typedData = this.buildPermitTypedData(owner, value, nonce, deadline);
    const signature = await wallet.signTypedData(typedData);

    const { receiptId } = await this.opts.facilitator.submit({
      scheme: 'eip2612',
      chainId: cfg.chainId,
      token: cfg.gccToken,
      owner,
      spender: cfg.sellerAddress,
      value: value.toString(),
      nonce: nonce.toString(),
      deadline,
      signature
    });

    if (this.opts.ledger) await this.opts.ledger.record(npcId, usage);

    return { gccCost: usage.gccCost ?? 0, mode: 'x402', receiptId };
  }
}
