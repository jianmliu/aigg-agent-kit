/** Sanitize an NPC/agent id into a filesystem/provenance-safe token. Used as the
 *  corpus segment, selfId, and assertedBy everywhere, so self-vs-social stays consistent. */
export function corpusId(npcId: string): string {
  return npcId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** The per-NPC memory corpus path the kernel addresses. */
export function corpusPath(npcId: string): string {
  return `npcs/${corpusId(npcId)}/memory`;
}
