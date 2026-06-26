/**
 * TbaAgentWallet — an AgentWallet backed by an NPC NFT's ERC-6551 Token Bound
 * Account. This is the NPC's on-chain wallet: `address` is the (counterfactual)
 * TBA, `balanceGcc()` reads GCC.balanceOf(TBA) live, and `signTypedData()`
 * delegates to the controlling EOA (the NFT owner) — which the TBA validates via
 * EIP-1271 (`isValidSignature`). For an *undeployed* TBA the consumer/facilitator
 * must ERC-6492-wrap (aigg-facilitator's DeployERC4337WithEIP6492 covers this).
 *
 * B2 scope: identity (address) + balance are fully live; signing is delegated to
 * an injected controller. Service-side only — the controller holds a key.
 */
import { createPublicClient, http, type PublicClient } from 'viem';
import type { AgentWallet, TypedDataPayload } from '@aigg/npc-agent';
import { computeTbaAddress, type TbaParams } from './tba';

const ERC20_BALANCE_ABI = [{
  name: 'balanceOf', type: 'function', stateMutability: 'view',
  inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }]
}] as const;

export interface TbaAgentWalletOptions extends TbaParams {
  /** GCC ERC-20 address (for balanceGcc); omit to disable balance reads. */
  gccToken?: `0x${string}`;
  /** RPC URL for balance reads; omit to disable (balanceGcc → null). */
  rpcUrl?: string;
  /** the EOA that owns the NFT and signs on the TBA's behalf (EIP-1271). */
  controller?: AgentWallet;
  /** inject a viem PublicClient (tests); otherwise built from rpcUrl. */
  client?: PublicClient;
}

export class TbaAgentWallet implements AgentWallet {
  readonly address: `0x${string}`;
  private readonly gccToken?: `0x${string}`;
  private readonly controller?: AgentWallet;
  private readonly client?: PublicClient;

  constructor(opts: TbaAgentWalletOptions) {
    this.address = computeTbaAddress(opts);
    this.gccToken = opts.gccToken;
    this.controller = opts.controller;
    this.client = opts.client ?? (opts.rpcUrl ? createPublicClient({ transport: http(opts.rpcUrl) }) : undefined);
  }

  async balanceGcc(): Promise<bigint | null> {
    if (!this.client || !this.gccToken) return null;
    return this.client.readContract({
      address: this.gccToken,
      abi: ERC20_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [this.address]
    }) as Promise<bigint>;
  }

  async signTypedData(payload: TypedDataPayload): Promise<`0x${string}`> {
    if (!this.controller) {
      throw new Error(
        '[TbaAgentWallet] no controller — TBA signing needs the NFT-owner EOA. ' +
        'Inject `controller` (an EoaAgentWallet for the owner); the TBA validates it via EIP-1271.'
      );
    }
    // The TBA's isValidSignature delegates to the current owner, so the owner
    // EOA's signature IS the TBA's signature once deployed (ERC-6492 if not).
    return this.controller.signTypedData(payload);
  }
}
