import type { Agent } from '../agent/agent';
import type { Actuator, Perception } from '../ports/ports';
import type { StateDelta } from '../intent/agent-intent';
import { EffectResolver } from '../resolver/effect-resolver';
import { RelationshipMemory } from '../memory/relationship';

export interface AgentRuntimeOptions {
  agent: Agent;
  resolver: EffectResolver;
  relationships: RelationshipMemory;
  actuator: Actuator;
  /** monotonic clock injected by the host (tests pass a fixed value). */
  now?: () => number;
}

export interface HandleResult {
  delta: StateDelta | null;
  said: string | null;
}

/**
 * AgentRuntime — the conductor for ONE perception:
 *   perceive → Agent.perceive (intent) → EffectResolver (validated delta)
 *   → apply relationship/memory + host effects → actuate (say).
 *
 * This is where the offchain-reasoning / deterministic-mutation boundary lives:
 * the Agent reasons (non-deterministic LLM), everything after the resolver is
 * deterministic and is what the host persists / (later) settles onchain.
 */
export class AgentRuntime {
  constructor(private readonly opts: AgentRuntimeOptions) {}

  async handle(perception: Perception): Promise<HandleResult> {
    const intent = await this.opts.agent.perceive(perception);
    if (!intent) return { delta: null, said: null };

    const ctx = {
      npcId: this.opts.agent.npcId,
      playerId: perception.playerId,
      sceneId: perception.sceneId ?? null
    };
    const delta = this.opts.resolver.resolve(ctx, intent);

    // Apply validated relationship adjustments to durable memory.
    const now = this.opts.now ? this.opts.now() : 0;
    for (const effect of delta.effects) {
      if (effect.kind === 'adjustRelationship') {
        await this.opts.relationships.applyDelta(
          ctx.npcId,
          ctx.playerId,
          effect.delta,
          effect.reason ? [] : [],
          now
        );
      }
    }

    // Hand non-relationship effects to the host (PAL adapter) to enact.
    const hostEffects = delta.effects.filter((e) => e.kind !== 'adjustRelationship');
    if (hostEffects.length) {
      await this.opts.actuator.apply({ ...delta, effects: hostEffects });
    }

    // Speak.
    let said: string | null = null;
    if (intent.say?.trim()) {
      said = intent.say.trim();
      await this.opts.actuator.say(ctx.npcId, said, { emotion: intent.emotion });
    }

    return { delta, said };
  }
}
