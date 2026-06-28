/**
 * @aigg/onchain — engine-neutral on-chain economy kit for AI agents.
 *
 * The reusable "wallet + settlement" half of the NPC agent stack, sitting on top
 * of @aigg/npc-agent's AgentWallet / SettlementStrategy seams. Zero game/PAL
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

// Remote signer — keys held by the Go wallet-svc (aigg-wallet), not in-process
export { AiggWalletClient, selectorBody } from './aigg-wallet-client';
export type { AiggWalletClientOptions, DeriveResult, SignResult, Eip3009Params, Eip3009Result, KeySelector, SignTxParams, SignTxResult } from './aigg-wallet-client';
export { RemoteAgentWallet } from './remote-agent-wallet';
export type { RemoteAgentWalletOptions } from './remote-agent-wallet';

// One-owner-many-agents: stable npcId → collision-free uint32 agent index
export { InMemoryNpcIndexRegistry, npcSelector } from './npc-index-registry';
export type { NpcIndexRegistry } from './npc-index-registry';
export { RemoteEip3009Settlement } from './remote-eip3009-settlement';
export type { RemoteEip3009SettlementOptions } from './remote-eip3009-settlement';

// On-chain STATE layer — npc-agent Store backed by Lattice MUD ECS
export { MudStore, mudKey, scopeKeyId } from './mud-store';
export type { MudStoreOptions, MudKvClient } from './mud-store';

// Model B — passkey-owned Coinbase Smart Wallet (non-custodial, P3)
export { CswWalletClient } from './csw-wallet-client';
export type { CswWalletClientOptions, CswOwner, WebAuthnAssertion, CswAccountResult, CswErc1271Result } from './csw-wallet-client';
export { CswAgentWallet } from './csw-agent-wallet';
export type { CswAgentWalletOptions, PasskeySigner } from './csw-agent-wallet';

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

// Native-coin checkpoint settlement (any EVM chain; 0G Chain default)
export { Native0gSettlementLayer, FakeNativeChain } from './native-0g-settlement';
export type { NativeChain, Native0gSettlementOptions, SettleTx } from './native-0g-settlement';
export { ViemNativeChain } from './viem-native-chain';
export type { ViemNativeChainOptions } from './viem-native-chain';
