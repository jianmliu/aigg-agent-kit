import type { Store } from '../store/store';
import type { RelationshipState } from './types';

const REL_KEY = 'relationship';

const DEFAULT: RelationshipState = { affinity: 0, tags: [] };

/**
 * RelationshipMemory — read/write the per-(NPC × player) RelationshipState via a
 * Store. Relationship is the durable, "world-changed-because-of-you" state; it is
 * written with `{ onchain: true }` so the (later) chain backend can pick it up —
 * but with the 2026-05 priority calibration, game-state onchain is OPTIONAL, so
 * local persistence is the terminal target unless that backend is wired.
 */
export class RelationshipMemory {
  constructor(private readonly store: Store) {}

  async get(npcId: string, playerId: string): Promise<RelationshipState> {
    const existing = await this.store.get<RelationshipState>(
      { type: 'npc-player', npcId, playerId },
      REL_KEY
    );
    return existing ?? { ...DEFAULT, tags: [] };
  }

  async applyDelta(
    npcId: string,
    playerId: string,
    delta: number,
    addTags: string[] = [],
    now = 0
  ): Promise<RelationshipState> {
    const current = await this.get(npcId, playerId);
    const tags = Array.from(new Set([...current.tags, ...addTags]));
    const next: RelationshipState = {
      ...current,
      affinity: current.affinity + delta,
      tags,
      lastInteractionAt: now || current.lastInteractionAt
    };
    await this.store.set({ type: 'npc-player', npcId, playerId }, REL_KEY, next, { onchain: true });
    return next;
  }
}
