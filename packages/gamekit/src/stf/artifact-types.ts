// Artifact = a unique, named, chronicle-engraved, soul-bound object an NPC forges in a strange
// mood (dwarf-world.md §4.4). Pure data + a deterministic id so applyTx stays replayable.
import { createHash } from 'node:crypto'

export type ArtifactKind = 'statue' | 'amulet' | 'relief' | 'weapon' | 'door' // 雕像/护符/浮雕/兵刃/石门

export interface ArtifactProvenance {
  creatorNpcId: string // 'npc:cragheart:urist'
  deedSeq: number      // chronicle seq of the commemorated deed
  worldId: string      // 'dwarf'
  season: number       // mood-season counter (monotonic, host-maintained)
  createdAt: number    // now (ms) — passed in, never read from the clock
  tba?: string         // computeTbaAddress(npc) — ①-layer soul binding (data-ready; no real mint in v1)
}

export interface ArtifactRecord {
  id: string               // = artifactId(...)
  kind: ArtifactKind
  name: string
  engraving: string
  materialsSilver: number  // silver spent to forge
  ownedBy: string          // npcId — soul-bound
  provenance: ArtifactProvenance
  onchain: true            // persisted on the onchain-ready durable path
}

/** Deterministic id from (creator, season, deed) → 'art:' + 16 hex. Replayable. */
export function artifactId(creatorNpcId: string, season: number, deedSeq: number): string {
  const h = createHash('sha256').update(`${creatorNpcId}:${season}:${deedSeq}`).digest('hex')
  return `art:${h.slice(0, 16)}`
}
