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
 *
 * ②层 world isolation (economy-multiverse spec §2): relationships live in the
 * `npc-player` Scope, NOT the `world` Scope, so SharedWorld.wkey() never reaches
 * them. To keep two worlds sharing one Store from colliding on the same
 * npcId+playerId, the **content key** carries the world prefix: `keyPrefix` is
 * prepended to REL_KEY (host passes `w:<worldId>:`). The Scope stays `npc-player`
 * on purpose — crossServerStable returns false for it, so hot per-visitor
 * relationship state still stays local (never mirrored per-turn to the on-chain
 * shared tier), exactly as PR-B intends. Default prefix '' = legacy bare key.
 */
export class RelationshipMemory {
  private readonly relKey: string;

  constructor(private readonly store: Store, keyPrefix = '') {
    this.relKey = `${keyPrefix}${REL_KEY}`;
  }

  async get(npcId: string, playerId: string): Promise<RelationshipState> {
    const existing = await this.store.get<RelationshipState>(
      { type: 'npc-player', npcId, playerId },
      this.relKey
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
    await this.store.set({ type: 'npc-player', npcId, playerId }, this.relKey, next, { onchain: true });
    return next;
  }
}
