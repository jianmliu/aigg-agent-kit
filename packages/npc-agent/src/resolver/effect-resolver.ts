import type { AgentIntent, StateDelta } from '../intent/agent-intent';
import type { Effect } from '../intent/effect';
import type { GameRules, RuleContext } from '../ports/ports';

/**
 * EffectResolver — turns an (untrusted) AgentIntent into a validated,
 * deterministic StateDelta. Every effect is checked against GameRules; survivors
 * go into `effects`, rejects into `rejected` (with reasons, for logging/anti-cheat).
 *
 * The StateDelta — never the AgentIntent and never the raw LLM output — is what
 * the host persists and (later) settles onchain. Deterministic by construction.
 */
export class EffectResolver {
  constructor(private readonly rules: GameRules) {}

  resolve(ctx: RuleContext, intent: AgentIntent): StateDelta {
    const effects: Effect[] = [];
    const rejected: Array<{ effect: Effect; reason: string }> = [];

    for (const effect of intent.effects ?? []) {
      const verdict = this.rules.validate(effect, ctx);
      if (verdict.ok) {
        effects.push(effect);
      } else {
        rejected.push({ effect, reason: verdict.reason });
      }
    }

    return {
      npcId: ctx.npcId,
      playerId: ctx.playerId,
      effects,
      memoryWrites: intent.memoryWrites ?? [],
      rejected
    };
  }
}
