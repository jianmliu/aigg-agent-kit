import type { ReplayPack } from '../schema';

/** Built-in, always implicitly present. Owns the unprefixed spatial/social verbs. */
export const CORE_PACK_ID = 'core@0';

export const corePack: ReplayPack = {
  id: CORE_PACK_ID,
  eventKinds: ['move', 'say'],
  viewer: { panels: [{ id: 'graph', title: 'Entities', render: 'entity-graph' }] },
};
