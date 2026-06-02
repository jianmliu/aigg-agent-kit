/**
 * NpcPersona — the stable identity an Agent reasons from. Engine-neutral; the
 * host maps its own NPC card (e.g. PAL's pal_npc_cards) into this shape.
 *
 * Distinct from memory: persona is fixed character definition; memory is the
 * evolving per-player relationship/episodic state.
 */
export interface NpcPersona {
  id: string;
  name: string;
  aliases?: string[];
  role: string;
  /** language/voice cues fed to the model. */
  tones?: string[];
  traits?: string[];
  motivations?: string[];
  /** hard "never do this" lines (from the card's boundaries). */
  boundaries?: string[];
  /** speech register, e.g. 文白夹杂 / 市井白话. */
  register?: string;
  /** forbidden phrasings/topics (from the card's taboos). */
  taboos?: string[];
  /** what the NPC knows / is allowed to talk about. */
  knowledge?: {
    home?: string;
    knownLocations?: string[];
    scopeRule?: string;
    spoilerRule?: string;
  };
  /** per-mode guidance copied from the source card's interaction_policy. */
  interactionPolicy?: Record<string, string>;
  /** how to address the player at given affinity thresholds (ascending). */
  addressing?: AddressingRule[];
  /** which effects this NPC is permitted to emit (capability scope). */
  allowedEffects?: string[];
  /** hard caps the EffectResolver enforces for this NPC. */
  caps?: {
    relationshipDeltaPerTurn?: number;
  };
}

export interface AddressingRule {
  /** applies when affinity >= minAffinity (pick the highest matching). */
  minAffinity: number;
  title: string;
}

/** Resolve how this NPC currently addresses the player given affinity. */
export function resolveAddressing(persona: NpcPersona, affinity: number): string {
  const rules = (persona.addressing ?? []).slice().sort((a, b) => a.minAffinity - b.minAffinity);
  let chosen = rules[0]?.title ?? '阁下';
  for (const rule of rules) {
    if (affinity >= rule.minAffinity) {
      chosen = rule.title;
    }
  }
  return chosen;
}
