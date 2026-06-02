/**
 * @onchainpal/onchain — engine-neutral on-chain economy kit for AI agents.
 *
 * The reusable "wallet + settlement" half of the NPC agent stack, sitting on top
 * of @onchainpal/npc-agent's AgentWallet / SettlementStrategy seams. Zero game/PAL
 * deps — usable by any agent app that wants per-agent identity + GCC payments.
 *
 * Node/service-side (holds keys, uses viem). Do NOT import into a browser bundle
 * unless you mean to ship key material — the browser drives inference through a
 * proxy instead (see proxy/), and reads balances via RPC.
 */

// Per-agent EOA identity (BIP-44 derived)
export { EoaAgentWallet, deriveNpcAgentAccount, npcAddressIndex } from './agent-eoa';

// ERC-6551 Token Bound Account (the NPC NFT's wallet)
export { computeTbaAddress, ERC6551_REGISTRY, TOKENBOUND_ACCOUNT_V3 } from './tba';
export type { TbaParams } from './tba';
export { TbaAgentWallet } from './tba-agent-wallet';
export type { TbaAgentWalletOptions } from './tba-agent-wallet';

// AIGG x402 facilitator client (verify / settle)
export { AiggFacilitatorClient } from './aigg-facilitator-client';
export type {
  AiggFacilitatorClientOptions, AiggFacilitatorRequest,
  X402SupportedResponse, X402VerifyResponse, X402SettleResponse
} from './aigg-facilitator-client';

// GCC settlement strategies (real on-chain x402)
export { X402GccEip3009Settlement } from './x402-gcc-eip3009';
export type {
  X402EipConfig, X402GccEip3009Options, PaymentRequirements, PaymentPayload
} from './x402-gcc-eip3009';
export { X402GccSettlement } from './x402-gcc-settlement';
export type { GccSettlementConfig, NonceProvider, FacilitatorClient, GccPermitPayment, X402GccSettlementOptions } from './x402-gcc-settlement';
