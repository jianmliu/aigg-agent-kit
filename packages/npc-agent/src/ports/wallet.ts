/**
 * AgentWallet — an NPC's economic identity + scoped signer. Engine-neutral: the
 * impl can be a derived EOA (per-NPC address), an ERC-6551 TBA, or a virtual
 * sub-ledger. The brain never touches keys — it only references the address and
 * asks for signatures.
 *
 * Aligns with AIGG's `X402PaymentSigner` (x402-permit2-agent-wallet design): the
 * caller (settlement layer / AIGG adapter) BUILDS the EIP-712 payload within scope
 * (Permit2 PermitSingle / GCC EIP-2612 permit / EIP-3009); the wallet only holds
 * the key and signs. Funds live in a funding EOA (AIGG-held for the demo), not here.
 */

/** Structural EIP-712 typed-data payload (viem-free so npc-agent stays light). */
export interface TypedDataPayload {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface AgentWallet {
  /** the NPC's on-chain address — its identity / signer. */
  readonly address: string;
  /** current GCC balance (atomic units), or null if not queryable here. */
  balanceGcc(): Promise<bigint | null>;
  /** sign an EIP-712 payload (the scoped agent signature for an x402 payment). */
  signTypedData(payload: TypedDataPayload): Promise<`0x${string}`>;
}
