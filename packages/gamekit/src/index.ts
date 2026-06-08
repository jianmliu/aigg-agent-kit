/**
 * @onchainpal/gamekit — game-design toolkit for shared, AI-NPC-populated text
 * worlds, built on @onchainpal/npc-agent. Store-agnostic: local (InMemoryStore)
 * or shared on-chain (MudStore over a Lattice MUD World).
 *
 * Also exports the AIGG platform NPC layer: fixed menu-based characters
 * (碧玄子 pricing consultant, …) that any MUD game on ai.gg can include
 * with one call — consistent platform access across all games.
 */
export { SharedWorld } from './shared-world';
export type { SharedWorldOptions, NpcRecord, NpcSummary, TalkResult, OnchainBalanceProvider } from './shared-world';

// Deterministic world STF + AI oracle boundary (sequencer / Autonomys-Domain ready).
export { applyTx, applyAll, stateRoot, emptyWorld, relKey } from './stf/world-stf';
export type { WorldState, WorldTx, WorldEvent, StfNpc } from './stf/world-stf';
export { mulberry32, rollLuck } from './stf/luck';
export type { LuckConfig, LuckEventTx } from './stf/luck';
export { LlmInferenceOracle } from './stf/inference-oracle';
export type { InferenceOracle, OracleInput, OracleOutput, LlmInferenceOracleOptions } from './stf/inference-oracle';
// AI-verifiability leg — attest + verify the oracle output (operator-sig now, TEE drop-in later).
export { OperatorAttestationVerifier, signAttestation, verifyTalkProvenance, attestationMessage, sha256Hex } from './stf/attestation-verifier';
export type { AttestationVerifier, VerifyResult, TalkProvenance } from './stf/attestation-verifier';
// Value leg — Base is the canonical asset-settlement layer (conservation invariant).
export { BaseSettlementLayer } from './stf/settlement-layer';
export type { SettlementLayer } from './stf/settlement-layer';

// Activation seam — first GCC top-up activates a draft NPC into a permanent entity.
export { LocalLedgerActivator, ActivationError } from './aigg/activation';
export type { Activator, ActivationInput, ActivationResult, ActivationLedgerEntry } from './aigg/activation';

// ── AIGG platform NPCs ───────────────────────────────────────────────────────
// One call seeds all platform-level NPCs into any SharedWorld.
// Games on ai.gg call: seedAiggPlatformNpcs(world).catch(console.warn)
export { seedAiggPlatformNpcs, AIGG_NPC_IDS, AIGG_PLATFORM_NPC_IDS, AIGG_DEFAULT_ROOM, AIGG_DEFAULT_NAMES } from './aigg/platform-npcs';
export type { AiggPlatformNpcOptions } from './aigg/platform-npcs';

// ai.gg API client (public endpoints, no auth required for pricing)
export { AiggApiClient, formatGccPricing, estimateGcc } from './aigg/aigg-api-client';
export type { AiggApiClientOptions, GccPricingTable, ModelGccPricing } from './aigg/aigg-api-client';

// Menu NPC primitives (extend to build custom menu NPCs for your game)
export { menuRegistry, buildPricingMenu, renderMenu } from './aigg/menu-npc';
export type { MenuNode, MenuAction, MenuState, MenuStepResult } from './aigg/menu-npc';

// Merchant NPC (秦薇) — pay/subscribe one-stop
export { buildMerchantMenu } from './aigg/merchant-menu';
export type { MerchantMenuOptions } from './aigg/merchant-menu';

// ai.gg exec-onchain client (Phase 2a — real-tx pipeline for merchant [2]/[3])
export { AiggExecClient, AiggExecError } from './aigg/aigg-exec-client';
export type {
  AiggExecClientOptions, ExecOptions, ExecRequest, ExecResponse,
  TopupGccResponse, BuyGccCcaResponse, TransferGccResponse, ExecResponseBase,
} from './aigg/aigg-exec-client';
export { DEMO_PLANS, ERC8257_TIERS } from './aigg/static-plans';
export type { DemoPlan } from './aigg/static-plans';

// Zero-dep on-chain balance reader (ERC-20 balanceOf)
export { ChainBalanceProvider, BASE_USDC, BASE_GCC, BASE_ERC8257_TOOL_REGISTRY } from './aigg/chain-balances';
export type { ChainBalanceProviderOptions, TokenBalance } from './aigg/chain-balances';
