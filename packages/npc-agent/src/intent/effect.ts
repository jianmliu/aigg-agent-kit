/**
 * Effect — the ONLY vocabulary through which an NPC agent can change the world.
 *
 * An agent never mutates game state directly. It emits Effects as part of its
 * AgentIntent; the EffectResolver validates each one against GameRules and turns
 * the surviving set into a deterministic StateDelta. This indirection is what
 * makes "NPC dialogue can advance the plot" possible AND keeps the system
 * onchain-safe: the chain settles the validated delta, never the LLM call.
 *
 * Effects are intentionally engine-neutral. `setFlag`/`giveItem` carry abstract
 * identifiers; the host adapter (e.g. PAL) maps them to its own state.
 */
export type Effect =
  | { kind: 'adjustRelationship'; delta: number; reason: string }
  | { kind: 'setFlag'; flag: string; value: number }
  | { kind: 'giveItem'; itemId: number; qty: number }
  | { kind: 'takeItem'; itemId: number; qty: number }
  | { kind: 'startQuest'; questId: string }
  | { kind: 'advanceQuest'; questId: string; step: string };

export type EffectKind = Effect['kind'];

/** The complete set of effect kinds an agent may be granted (capability scope). */
export const ALL_EFFECT_KINDS: readonly EffectKind[] = [
  'adjustRelationship',
  'setFlag',
  'giveItem',
  'takeItem',
  'startQuest',
  'advanceQuest'
];
