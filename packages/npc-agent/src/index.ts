/**
 * @onchainpal/npc-agent — engine-neutral NPC agent runtime.
 *
 * Zero PAL / game-engine dependencies BY DESIGN: the brain must not know which
 * game skin it runs in. Hosts (e.g. the PAL adapter in game-engine) implement
 * the ports here and depend on this package, never the reverse.
 *
 * This barrel currently exposes the contracts (the "seam"). Concrete runtime
 * pieces — Agent impl, memory stores, inference providers, EffectResolver —
 * land in subsequent P0 steps behind these same types.
 */

// Intent & effects — the structured-decision contract
export type { AgentIntent, StateDelta } from './intent/agent-intent';
export type { Effect, EffectKind } from './intent/effect';
export { ALL_EFFECT_KINDS } from './intent/effect';

// Memory model
export type { MemoryEntry, MemoryTier, RelationshipState } from './memory/types';

// Persistence seam (the onchain attach point)
export type { Store, Scope, WriteOptions } from './store/store';

// Host ports
export type {
  Perception,
  PerceptionSource,
  Actuator,
  SayOptions,
  GameRules,
  RuleContext,
  RuleVerdict,
  Unsubscribe
} from './ports/ports';

// Wallet port (NPC identity / scoped signer; impl = EOA / ERC-6551 TBA / virtual)
export type { AgentWallet, TypedDataPayload } from './ports/wallet';

// Inference seam
export type {
  InferenceProvider,
  InferenceRequest,
  InferenceResult,
  InferenceUsage,
  Attestation
} from './inference/provider';
export { OllamaProvider } from './inference/ollama-provider';
export type { OllamaProviderOptions } from './inference/ollama-provider';
export { ProxyProvider } from './inference/proxy-provider';
export type { ProxyProviderOptions } from './inference/proxy-provider';
// NOTE: ClaudeProvider is intentionally NOT re-exported here — it pulls
// @anthropic-ai/sdk (node-heavy: node:fs, child_process) which must not enter the
// browser bundle. Node-only consumers deep-import it:
//   import { ClaudeProvider } from '@onchainpal/npc-agent/inference/claude-provider'

// Persona
export type { NpcPersona, AddressingRule } from './persona/persona';
export { resolveAddressing } from './persona/persona';

// Intent parsing (untrusted LLM output → AgentIntent)
export { parseAgentIntent } from './intent/parse';
export type { ParseResult } from './intent/parse';

// Resolver + default rules
export { EffectResolver } from './resolver/effect-resolver';
export { DefaultGameRules } from './resolver/game-rules';

// Memory backends
export { InMemoryStore } from './memory/memory-store';
export { RelationshipMemory } from './memory/relationship';
export { AutoDriveStore } from './store/auto-drive-store';
export type { AutoDriveClient, AutoDriveStoreOptions, MemoryHistoryEntry } from './store/auto-drive-store';

// Economy — per-NPC virtual GCC sub-ledger (demo: game funds one AIGG account)
export { GccLedger } from './economy/gcc-ledger';
export type { GccLedgerEntry } from './economy/gcc-ledger';

// Settlement seam — ledger-only (demo) vs real x402 on-chain (post-demo)
export { LedgerSettlement } from './settlement/settlement';
export type { SettlementStrategy, SettlementResult } from './settlement/settlement';

// Cognitive metabolism — GCC balance gates/routes NPC thinking (I-phase)
export { Metabolism, hungerIntent, DEFAULT_METABOLISM } from './economy/metabolism';
export type { MetabolicTier, MetabolismConfig, MetabolicDecision } from './economy/metabolism';

// Agent brain + runtime
export type { Agent } from './agent/agent';
export { LlmAgent } from './agent/llm-agent';
export type { LlmAgentOptions } from './agent/llm-agent';
export { AgentRuntime } from './runtime/agent-runtime';
export type { AgentRuntimeOptions, HandleResult } from './runtime/agent-runtime';

export const npcAgentContractsReady = true;
