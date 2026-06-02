/**
 * x402 EIP-3009 GCC settlement — builds the **x402-foundation/x402** spec
 * `PaymentRequirements` + `PaymentPayload` pair the AIGG facilitator expects
 * (confirmed from aigg-facilitator main.go + sub2api payment_x402_topup.go).
 *
 * Why EIP-3009 and not EIP-2612 yet:
 * - The deployed aigg-facilitator routes `scheme: "exact"` through
 *   `evmfacilitator.NewExactEvmScheme`, which auto-dispatches BOTH EIP-3009 and
 *   Permit2 — but the GCC top-up path in sub2api production today uses EIP-3009
 *   (`payment_x402_topup.go:eip3009RequirementExtra`). EIP-2612 / Permit2 are the
 *   spec's later migration (2026-05-31 doc); we match the current path first.
 *
 * Per-NPC AgentWallet (EOA, BIP-44 derived) signs the EIP-3009
 * TransferWithAuthorization. The facilitator submits it on Base mainnet.
 */
import type { AgentWallet, InferenceUsage, SettlementStrategy, SettlementResult, GccLedger, TypedDataPayload } from '@onchainpal/npc-agent';
import type { AiggFacilitatorClient, X402SettleResponse, X402VerifyResponse } from './aigg-facilitator-client';
import { keccak256, toBytes } from 'viem';

export interface X402EipConfig {
  /** GCC ERC-20 address on Base. */
  gccToken: `0x${string}`;
  /** GCC `name()` for EIP-712 domain (e.g. "Guaranteed Capacity Credit"). */
  gccName: string;
  /** chain id (Base mainnet = 8453). */
  chainId: number;
  /** facilitator network token ("eip155:8453"). */
  network: string;
  /** AIGG seller address receiving GCC (the payTo / receiveWithAuthorization to). */
  payTo: `0x${string}`;
  /** GCC decimals (18). */
  decimals?: number;
  /** PaymentRequirements.maxTimeoutSeconds. */
  maxTimeoutSeconds?: number;
}

/** matches sub2api X402PaymentRequirement struct + standard x402 v2 fields. */
export interface PaymentRequirements {
  scheme: 'exact';
  network: string;
  asset: string;
  amount: string;
  maxTimeoutSeconds: number;
  payTo: string;
  extra: { name: string; version: string; verifyingContract: string };
  resource?: string;
  description?: string;
  mimeType?: string;
  outputSchema?: unknown;
  payToBy?: string;
}

/**
 * x402 v2 PaymentPayload (EIP-3009 mode). Per x402-foundation/x402/types:
 * `scheme`/`network` (+ `amount`/`asset`/`payTo`) live INSIDE `accepted`, NOT at
 * top level. Top level is just `x402Version` + `payload` + `accepted`.
 */
export interface PaymentPayload {
  x402Version: number;
  accepted: {
    scheme: 'exact';
    network: string;
    amount: string;
    asset: string;
    payTo: string;
  };
  payload: {
    signature: `0x${string}`;
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: `0x${string}`;
    };
  };
}

function gccToAtomic(gccCost: number, decimals: number): bigint {
  return BigInt(Math.round(gccCost * 10 ** decimals));
}

/** random bytes32, deterministic-ish so a replay can be detected upstream. */
function randomNonce(seed: string): `0x${string}` {
  return keccak256(toBytes(`${seed}:${Math.random()}:${Date.now()}`));
}

export interface X402GccEip3009Options {
  config: X402EipConfig;
  walletFor: (npcId: string) => AgentWallet;
  facilitator: AiggFacilitatorClient;
  ledger?: GccLedger;
  /** if true, only call /verify (no on-chain settle). Default true for safety. */
  verifyOnly?: boolean;
  now?: () => number;
  /** include extra X402PaymentRequirement fields (resource/description for top-up flows). */
  requirementsExtras?: Partial<Pick<PaymentRequirements, 'resource' | 'description' | 'mimeType'>>;
}

export class X402GccEip3009Settlement implements SettlementStrategy {
  constructor(private readonly opts: X402GccEip3009Options) {}

  /** the EIP-712 typed data the AgentWallet signs (EIP-3009 ReceiveWithAuthorization shape). */
  buildAuthorizationTypedData(from: string, value: bigint, validAfter: number, validBefore: number, nonce: `0x${string}`): TypedDataPayload {
    const { gccName, gccToken, chainId, payTo } = this.opts.config;
    return {
      // ERC20Permit (OpenZeppelin) defaults the EIP-712 domain version to "1";
      // GCC.sol inherits ERC20Permit with no override, so version="1".
      domain: { name: gccName, version: '1', chainId, verifyingContract: gccToken },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' }
        ]
      },
      primaryType: 'TransferWithAuthorization',
      message: { from, to: payTo, value, validAfter, validBefore, nonce }
    };
  }

  buildRequirements(amountAtomic: bigint): PaymentRequirements {
    const c = this.opts.config;
    return {
      scheme: 'exact',
      network: c.network,
      asset: c.gccToken,
      amount: amountAtomic.toString(),
      maxTimeoutSeconds: c.maxTimeoutSeconds ?? 300,
      payTo: c.payTo,
      extra: { name: c.gccName, version: '1', verifyingContract: c.gccToken },
      ...(this.opts.requirementsExtras ?? {})
    };
  }

  async build(npcId: string, usage: InferenceUsage): Promise<{ payload: PaymentPayload; requirements: PaymentRequirements }> {
    const c = this.opts.config;
    const wallet = this.opts.walletFor(npcId);
    const from = wallet.address;
    const value = gccToAtomic(usage.gccCost ?? 0, c.decimals ?? 18);
    const now = this.opts.now ? this.opts.now() : Math.floor(Date.now() / 1000);
    const validAfter = now - 10; // small clock-skew buffer
    const validBefore = now + (c.maxTimeoutSeconds ?? 300);
    const nonce = randomNonce(`${npcId}:${from}:${now}`);

    const signature = await wallet.signTypedData(this.buildAuthorizationTypedData(from, value, validAfter, validBefore, nonce));
    const requirements = this.buildRequirements(value);
    const payload: PaymentPayload = {
      x402Version: 2,
      accepted: {
        scheme: 'exact',
        network: c.network,
        amount: value.toString(),
        asset: c.gccToken,
        payTo: c.payTo
      },
      payload: {
        signature,
        authorization: {
          from,
          to: c.payTo,
          value: value.toString(),
          validAfter: validAfter.toString(),
          validBefore: validBefore.toString(),
          nonce
        }
      }
    };
    return { payload, requirements };
  }

  async settle(npcId: string, usage: InferenceUsage): Promise<SettlementResult> {
    const built = await this.build(npcId, usage);
    let receiptId: string | undefined;
    if (this.opts.verifyOnly !== false) {
      const v = await this.opts.facilitator.verify({ paymentPayload: built.payload, paymentRequirements: built.requirements });
      if (!v.isValid) throw new Error(`facilitator verify rejected: ${v.invalidReason ?? 'unknown'}`);
      receiptId = `verify:${(v.payer as string) ?? built.payload.payload.authorization.from}`;
    } else {
      const s: X402SettleResponse = await this.opts.facilitator.settle({ paymentPayload: built.payload, paymentRequirements: built.requirements });
      if (!s.success) throw new Error(`facilitator settle failed: ${s.errorReason ?? 'unknown'}`);
      receiptId = s.transaction;
    }
    if (this.opts.ledger) await this.opts.ledger.record(npcId, usage);
    return { gccCost: usage.gccCost ?? 0, mode: 'x402', receiptId };
  }
}

// expose unused VerifyResponse type to consumers
export type { X402VerifyResponse };
