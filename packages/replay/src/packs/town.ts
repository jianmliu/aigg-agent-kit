import type { ReplayPack, Event } from '../schema';

export const TOWN_PACK_ID = 'town@0';

/** 0gtown's learn-loop. TEE attestations + 0G Storage roots are first-class. */
export const townPack: ReplayPack = {
  id: TOWN_PACK_ID,
  eventKinds: ['town.talk', 'town.pitch', 'town.refuse', 'town.anchor'],
  validateEvent(ev: Event): string[] {
    const errs: string[] = [];
    const d = ev.data ?? {};
    if (ev.kind === 'town.talk' && d.verified === true) {
      const att = d.attestation as { signature?: unknown } | undefined;
      if (!att || typeof att.signature !== 'string' || !att.signature) {
        errs.push('town.talk verified:true requires attestation.signature');
      }
    }
    if (ev.kind === 'town.refuse') {
      if (d.protected !== true) errs.push('town.refuse must set protected:true');
      if (!d.claim) errs.push('town.refuse must reference a claim');
    }
    if (ev.kind === 'town.anchor') {
      if (typeof d.beliefRoot !== 'string' || !d.beliefRoot) {
        errs.push('town.anchor must carry a non-empty beliefRoot');
      }
    }
    return errs;
  },
  viewer: { panels: [{ id: 'ledger', title: 'Learn Ledger', render: 'town-ledger' }] },
};
