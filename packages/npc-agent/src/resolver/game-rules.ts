import type { Effect, GameRules, RuleContext, RuleVerdict } from '../index';
import type { NpcPersona } from '../persona/persona';

/**
 * DefaultGameRules — an engine-neutral baseline that bounds what an NPC may do,
 * driven by the NPC's persona capability scope. Hosts (e.g. PAL) can wrap or
 * replace this with game-specific rules (item existence, quest graph validity).
 *
 * This is the anti-cheat / sanity layer: the LLM can *ask* for any effect, but
 * only effects that pass here reach the StateDelta.
 */
export class DefaultGameRules implements GameRules {
  constructor(private readonly personaById: (id: string) => NpcPersona | undefined) {}

  validate(effect: Effect, ctx: RuleContext): RuleVerdict {
    const persona = this.personaById(ctx.npcId);

    // capability scope: if the persona declares allowedEffects, enforce it
    if (persona?.allowedEffects && !persona.allowedEffects.includes(effect.kind)) {
      return { ok: false, reason: `${ctx.npcId} is not allowed to emit ${effect.kind}` };
    }

    switch (effect.kind) {
      case 'adjustRelationship': {
        const cap = persona?.caps?.relationshipDeltaPerTurn ?? 20;
        if (!Number.isFinite(effect.delta)) return { ok: false, reason: 'delta not finite' };
        if (Math.abs(effect.delta) > cap) {
          return { ok: false, reason: `relationship delta ${effect.delta} exceeds cap ${cap}` };
        }
        if (!effect.reason?.trim()) return { ok: false, reason: 'relationship change needs a reason' };
        return { ok: true };
      }
      case 'giveItem':
      case 'takeItem':
        if (!Number.isInteger(effect.itemId) || effect.itemId < 0) {
          return { ok: false, reason: 'invalid itemId' };
        }
        if (!Number.isInteger(effect.qty) || effect.qty <= 0) {
          return { ok: false, reason: 'invalid qty' };
        }
        return { ok: true };
      case 'setFlag':
        if (!effect.flag?.trim()) return { ok: false, reason: 'empty flag' };
        return { ok: true };
      case 'startQuest':
      case 'advanceQuest':
        if (!effect.questId?.trim()) return { ok: false, reason: 'empty questId' };
        return { ok: true };
      default: {
        const _exhaustive: never = effect;
        return { ok: false, reason: `unknown effect ${(_exhaustive as Effect).kind}` };
      }
    }
  }
}
