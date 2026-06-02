/**
 * Per-NPC agent EOA — each NPC gets its own deterministic on-chain address (its
 * scoped signer identity), derived BIP-44 from one master mnemonic/seed. Mirrors
 * AIGG's per-user Agent EOA (`m/44'/...'/<index>'`): the EOA holds NO funds (the
 * AIGG funding EOA does, authorized via Permit2) — it only signs payments in scope.
 *
 * SERVICE-SIDE ONLY: the master mnemonic / derived keys must never reach the
 * browser. This module is not imported by the browser runtime path (the demo
 * uses GccLedger + AIGG-side funding); it's the post-demo identity primitive.
 */
import { mnemonicToAccount } from 'viem/accounts';
import { keccak256, toBytes } from 'viem';
import type { AgentWallet, TypedDataPayload } from '@onchainpal/npc-agent';

/** Deterministic uint31 BIP-44 address_index from an npcId (collision-negligible). */
export function npcAddressIndex(npcId: string): number {
  const h = keccak256(toBytes(npcId)); // 0x + 64 hex
  return Number(BigInt(h) & 0x7fffffffn);
}

/** Derive the NPC's HD account at m/44'/60'/0'/0/<index(npcId)>. */
export function deriveNpcAgentAccount(mnemonic: string, npcId: string) {
  return mnemonicToAccount(mnemonic, { addressIndex: npcAddressIndex(npcId) });
}

/**
 * EoaAgentWallet — an AgentWallet backed by the per-NPC derived EOA. `address` is
 * the NPC's identity; `signTypedData` signs Permit2/EIP-2612/EIP-3009 payloads the
 * settlement layer builds. `balanceGcc` is not read here (the funding EOA holds GCC
 * in the demo) — returns null until an RPC reader is wired.
 */
export class EoaAgentWallet implements AgentWallet {
  readonly address: string;
  private readonly account: ReturnType<typeof mnemonicToAccount>;

  constructor(mnemonic: string, readonly npcId: string) {
    this.account = deriveNpcAgentAccount(mnemonic, npcId);
    this.address = this.account.address;
  }

  async balanceGcc(): Promise<bigint | null> {
    return null; // TODO: read GCC.balanceOf(address) via RPC when needed
  }

  async signTypedData(payload: TypedDataPayload): Promise<`0x${string}`> {
    // viem's signTypedData has strict generic types; the structural payload maps 1:1.
    return this.account.signTypedData(payload as Parameters<typeof this.account.signTypedData>[0]);
  }
}
