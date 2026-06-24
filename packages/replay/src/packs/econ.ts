import type { ReplayPack } from '../schema';

export const ECON_PACK_ID = 'econ@0';

/**
 * econ@0 — specified to prove the neutral core subsumes pumptown/replay@0.
 * Event vocabulary + viewer panels only; validation and the monopoly/mud-demo
 * rewiring are deferred to their own cycle.
 */
export const econPack: ReplayPack = {
  id: ECON_PACK_ID,
  eventKinds: [
    'econ.trade', 'econ.pump', 'econ.dump', 'econ.blackswan', 'econ.bill',
    'econ.burn', 'econ.patron', 'econ.dividend', 'econ.bet', 'econ.trust', 'econ.reflect',
  ],
  viewer: {
    panels: [
      { id: 'price', title: 'Price', render: 'econ-price' },
      { id: 'wealth', title: 'Wealth', render: 'econ-wealth' },
    ],
  },
};
