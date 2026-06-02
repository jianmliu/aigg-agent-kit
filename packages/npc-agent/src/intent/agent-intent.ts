import type { Effect } from './effect';
import type { MemoryEntry } from '../memory/types';

/**
 * AgentIntent — the structured output an NPC agent produces per perception.
 *
 * This is the core architectural shift: the LLM no longer returns "a line of
 * text", it returns a DECISION. `say` is what the NPC utters; `effects` are the
 * world changes it wants to make; `memoryWrites` are what it chooses to remember.
 * Untrusted (LLM-generated) — must be schema-validated before use, and every
 * effect re-validated by the EffectResolver against GameRules.
 */
export interface AgentIntent {
  say?: string;
  effects?: Effect[];
  memoryWrites?: MemoryEntry[];
  /** free-form mood hint for the host to render (animation, portrait, tone). */
  emotion?: string;
}

/**
 * StateDelta — the EffectResolver's output: the validated, deterministic set of
 * changes ready to (a) persist via Store and (b) actuate via the host Actuator.
 *
 * This — not the AgentIntent and never the raw LLM response — is what gets
 * settled onchain. Deterministic by construction, so it is replayable.
 */
export interface StateDelta {
  npcId: string;
  playerId: string;
  /** effects that passed GameRules validation. */
  effects: Effect[];
  memoryWrites: MemoryEntry[];
  /** effects the resolver dropped, with reasons (for logging / anti-cheat). */
  rejected: Array<{ effect: Effect; reason: string }>;
}
