/**
 * Memory model — scoped per (NPC × player), tiered.
 *
 * Replaces the old global 3-line dialog buffer. The tiers separate transient
 * conversation context from durable relationship state so the right thing gets
 * persisted (and, later, the right subset goes onchain).
 *
 * Implementations (stores, consolidation) land in later P0 steps; these are the
 * shared shapes the contracts depend on.
 */

export type MemoryTier =
  | 'working' // current conversation turns; ephemeral
  | 'episodic' // notable events ("player helped me find my son"); summarized + embedded
  | 'semantic' // stable persona/world facts (mostly from the NPC card)
  | 'relationship'; // distilled standing of this player with this NPC

export interface MemoryEntry {
  tier: MemoryTier;
  text: string;
  /** 0..1 — drives consolidation and pruning; higher survives longer. */
  salience?: number;
  tags?: string[];
  /** epoch ms; stamped by the host/store, not the agent. */
  timestamp?: number;
}

/**
 * RelationshipState — the distilled, durable standing between one NPC and one
 * player. This is the field set most likely to be tagged `onchain` later, since
 * "the world changed because of you" lives here.
 */
export interface RelationshipState {
  /** signed scalar, e.g. -100..100. Drives addressing and unlocks. */
  affinity: number;
  trust?: number;
  /** semantic tags the NPC remembers: 'drinking-buddy', 'helped-find-son'. */
  tags: string[];
  /** the title the NPC currently uses for this player (resolved from affinity/tags). */
  addressing?: string;
  lastInteractionAt?: number;
}
