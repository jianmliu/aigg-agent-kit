import type { Effect } from '../intent/effect';
import type { StateDelta } from '../intent/agent-intent';

export type Unsubscribe = () => void;

/**
 * Perception — a neutral observation the host feeds into the agent runtime.
 * Engine-agnostic on purpose: no PAL coordinates, no Big5, no event-object ids
 * beyond an opaque `data` bag. The PAL adapter is responsible for translating
 * its internal world into these.
 */
export interface Perception {
  kind:
    | 'interaction' // player initiated talk with this NPC
    | 'proximity-enter'
    | 'proximity-exit'
    | 'flag-change'
    | 'dialog-line' // a line surfaced in the conversation
    | 'tick';
  /** the NPC this perception concerns, if targeted. */
  npcId?: string;
  /** who the player is — the key for per-player memory and relationship. */
  playerId: string;
  /** who the NPC is actually speaking WITH — the player, or a fellow NPC
   *  (钱塘大集 NPC↔NPC). Drives how the line is framed/addressed; when absent
   *  the prompt assumes the player. */
  interlocutor?: { name: string; kind: 'player' | 'npc' };
  sceneId?: number | null;
  /** distance in abstract tiles, if spatial. */
  distance?: number;
  /** any player/world utterance carried by this perception. */
  text?: string;
  /** opaque host-specific extras the agent may pass through but should not depend on. */
  data?: Record<string, unknown>;
  timestamp: number;
}

/** Host implements: the source of perceptions. */
export interface PerceptionSource {
  subscribe(handler: (perception: Perception) => void): Unsubscribe;
}

export interface SayOptions {
  emotion?: string;
  /** pause and wait for player input after the line (vs auto-advance). */
  awaitInput?: boolean;
}

/**
 * Host implements: how an agent affects the world.
 *  - `say` renders an utterance in the host's dialog system.
 *  - `apply` enacts a validated StateDelta against host state.
 * The host (PAL adapter) owns all engine specifics (encoding, flags, items).
 */
export interface Actuator {
  say(npcId: string, line: string, opts?: SayOptions): Promise<void>;
  apply(delta: StateDelta): Promise<void>;
}

export interface RuleContext {
  npcId: string;
  playerId: string;
  sceneId?: number | null;
}

export type RuleVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Host implements: the rules that bound which effects are legal in this game.
 * Keeps the EffectResolver engine-neutral — it asks GameRules rather than
 * hardcoding "an NPC can't give 999 gold".
 */
export interface GameRules {
  validate(effect: Effect, ctx: RuleContext): RuleVerdict;
}
