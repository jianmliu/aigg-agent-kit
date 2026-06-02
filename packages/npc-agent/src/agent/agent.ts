import type { Perception } from '../ports/ports';
import type { AgentIntent } from '../intent/agent-intent';

/**
 * Agent — the engine-neutral NPC brain.
 *
 * One instance per active NPC. It owns the NPC's persona, memory, goals and a
 * decision policy. It is EVENT-DRIVEN: the runtime calls `perceive` when
 * something relevant happens (interaction, proximity, flag change), instead of
 * a global 500ms tick polling everyone. `perceive` returns an AgentIntent
 * (or null to stay silent), which the runtime feeds to the EffectResolver and
 * the host Actuator.
 *
 * The concrete implementation (persona + memory retrieval + inference +
 * intent assembly) lands in P0 step ③. This interface is the contract the
 * runtime and the PAL adapter code against now.
 */
export interface Agent {
  readonly npcId: string;
  perceive(perception: Perception): Promise<AgentIntent | null>;
}
