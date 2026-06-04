/**
 * NpcIndexRegistry — maps a stable npcId string to a collision-free uint32
 * BIP-44 agent index, so each NPC derives a unique EOA
 * `m/44'/<coin>'/<owner>'/<index>'` under the owner (the aigg-src user that owns
 * the game). Indices are assigned SEQUENTIALLY (not keccak(npcId)) so two NPCs
 * can never share a wallet — the 31-bit keccak scheme collides at ~55k subjects.
 *
 * The (npcId → index) mapping MUST be persisted by the host (e.g. onchainpal's
 * MUD store) so the same npcId always resolves to the same index across
 * restarts. This in-memory impl takes the persisted pairs in its constructor
 * and exposes `entries()` to write them back.
 */

const MAX_HARDENED = 0x80000000; // 2^31 — hardened BIP-44 index ceiling

export interface NpcIndexRegistry {
  /** Stable uint32 index for npcId, assigning the next free one if new. */
  indexFor(npcId: string): number;
  /** True if npcId already has an index. */
  has(npcId: string): boolean;
  /** All (npcId → index) pairs, for persistence. */
  entries(): Array<[string, number]>;
}

export class InMemoryNpcIndexRegistry implements NpcIndexRegistry {
  private readonly map = new Map<string, number>();
  private next = 0;

  /**
   * Rehydrate from persisted (npcId, index) pairs. `next` resumes at
   * max(index)+1 so a restart never re-assigns or collides an existing index.
   */
  constructor(initial?: Iterable<[string, number]>) {
    if (initial) {
      for (const [id, idx] of initial) {
        if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_HARDENED) {
          throw new Error(`NpcIndexRegistry: bad persisted index ${idx} for ${id}`);
        }
        this.map.set(id, idx);
        if (idx >= this.next) this.next = idx + 1;
      }
    }
  }

  indexFor(npcId: string): number {
    const existing = this.map.get(npcId);
    if (existing !== undefined) return existing;
    if (this.next >= MAX_HARDENED) {
      throw new Error('NpcIndexRegistry: exhausted hardened index space (2^31)');
    }
    const idx = this.next++;
    this.map.set(npcId, idx);
    return idx;
  }

  has(npcId: string): boolean {
    return this.map.has(npcId);
  }

  entries(): Array<[string, number]> {
    return [...this.map.entries()];
  }
}

/**
 * Build the structured wallet-svc selector for an NPC under a given owner —
 * `{ owner: aiggUserId, agent: npcIndex }`. Pass the result to
 * AiggWalletClient.address / .signEip3009 or RemoteAgentWallet.
 */
export function npcSelector(
  ownerId: number,
  registry: NpcIndexRegistry,
  npcId: string
): { owner: number; agent: number } {
  if (!Number.isInteger(ownerId) || ownerId < 1 || ownerId >= MAX_HARDENED) {
    throw new Error(`npcSelector: owner (AIGG_OWNER_ID) must be an integer in [1, 2^31), got ${ownerId}`);
  }
  return { owner: ownerId, agent: registry.indexFor(npcId) };
}
