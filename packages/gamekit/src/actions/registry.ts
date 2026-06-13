/**
 * ActionRegistry — the action-loop P1 keystone (docs/specs/agent-action-loop.md
 * §4.1). An NPC no longer runs a hardcoded FairTick role; each eligible turn an
 * LLM picks ONE operator from a declarative, extensible registry, gated by a
 * pure `available(ctx)` predicate.
 *
 * Determinism (humble-brewing-conway / inference-oracle 铁律):
 *   - `available()` is a PURE function over an already-assembled, synchronous
 *     ActionContext — no IO, no Date.now(), no randomness. The async assembly
 *     happens once in SharedWorld.buildActionContext (tick 内 await), so the
 *     gate stays replayable.
 *   - The LLM chooses the action+args (the impure oracle, a signable input);
 *     `resolve()` is pure and returns Effect[]/say/cost (+ an optional
 *     SharedWorld op hook for non-Effect actions like trade/pitch/give).
 *     STF only ever APPLIES — the LLM never runs inside applyTx, so fraud
 *     proofs are unchanged.
 */
import type { Effect, NpcPersona, NeedsState, RelationshipState } from '@onchainpal/npc-agent';
import type { NpcSummary } from '../shared-world';
import type { SharedWorld } from '../shared-world';

/**
 * The synchronous, already-assembled context an action sees. Built once per
 * turn by SharedWorld.buildActionContext (the async原料 read happens THERE);
 * everything here is a plain snapshot so available()/resolve() stay pure.
 */
export interface ActionContext {
  npcId: string;
  persona: NpcPersona;
  room: string;
  /** co-located others (self excluded) — say/pitch/give targets. */
  npcsInRoom: NpcSummary[];
  balanceGcc: number;
  balanceSilver: number;
  needs: NeedsState;
  /** spot 米价 (银两 per 米) — null until the market is seeded. */
  ricePrice: number | null;
  /** the market room id (trade gate) — undefined ⇒ no room constraint. */
  marketRoom?: string;
  /** optional relationship hint (say). P1 may leave undefined. */
  rel?: RelationshipState;
  /** tick-injected deterministic timestamp (NOT Date.now() inside the action). */
  now: number;
}

/**
 * What an action's resolve produces. Two落地 modes (turnFlow §6):
 *   - `effects` non-empty (say/move) →走 the SAME talk()/pushGoto chain as today.
 *   - `sharedWorldOp` (trade/pitch/give) → each calls its existing SharedWorld
 *     method, which already runs applyTx + emit internally.
 * Both reach the event stream (tick-anchored). LLM choice is the only impure source.
 */
export interface ActionResolveOut {
  effects: Effect[];
  say?: string;
  /** GCC this action's resolution implies (informational; thinking burn is the oracle's). */
  cost?: number;
  /** non-Effect execution hook — the action's existing SharedWorld method. */
  sharedWorldOp?: (w: SharedWorld) => Promise<void>;
}

export interface ActionSchema {
  description: string;
  /** function-calling JSON Schema for the args object. */
  params: Record<string, unknown>;
}

export interface WorldAction {
  id: 'move' | 'say' | 'trade' | 'pitch' | 'give' | string;
  /** PURE gate: reads only the assembled synchronous ctx (no IO/random/Date). */
  available(ctx: ActionContext): boolean;
  schema: ActionSchema;
  /** PURE: LLM-chosen call → effects/say/cost (+ optional SharedWorld op). */
  resolve(ctx: ActionContext, args: unknown): ActionResolveOut;
}

/** The LLM's chosen move — the signable turn input (determinism §). */
export interface ChosenAction {
  actionId: string;
  args: unknown;
  /** optional spoken line the model wants this turn (say action uses it directly). */
  say?: string;
}

export class ActionRegistry {
  constructor(private readonly actions: WorldAction[]) {}

  /** the available subset for this ctx — the action space offered to the LLM. */
  available(ctx: ActionContext): WorldAction[] {
    return this.actions.filter((a) => a.available(ctx));
  }

  get(id: string): WorldAction | undefined {
    return this.actions.find((a) => a.id === id);
  }

  /** the menu rendered to the LLM (only available actions). */
  schemas(ctx: ActionContext): Array<{ id: string; description: string; params: Record<string, unknown> }> {
    return this.available(ctx).map((a) => ({ id: a.id, description: a.schema.description, params: a.schema.params }));
  }

  /** all registered action ids (for fallback resolution in the parser). */
  ids(): string[] {
    return this.actions.map((a) => a.id);
  }
}
