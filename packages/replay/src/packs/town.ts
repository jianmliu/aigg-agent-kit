import type { ReplayPack, Event, ValidateCtx } from '../schema';

export const TOWN_PACK_ID = 'town@0';

/** 0gtown's learn-loop. TEE attestations + 0G Storage roots are first-class. */
export const townPack: ReplayPack = {
  id: TOWN_PACK_ID,
  eventKinds: ['town.talk', 'town.pitch', 'town.refuse', 'town.anchor', 'town.belief', 'town.warn', 'town.trust', 'town.propose', 'town.vote', 'town.sanction', 'town.lend', 'town.default', 'town.rap'],
  validateEvent(ev: Event, _ctx: ValidateCtx): string[] {
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
    if (ev.kind === 'town.vote' && d.choice !== 'for' && d.choice !== 'against') {
      errs.push("town.vote requires data.choice of 'for' or 'against'");
    }
    if (ev.kind === 'town.sanction' && typeof d.passed !== 'boolean') {
      errs.push('town.sanction requires a boolean data.passed');
    }
    if (ev.kind === 'town.default' && (typeof d.owed !== 'number' || typeof d.recovered !== 'number')) {
      errs.push('town.default requires numeric data.owed and data.recovered');
    }
    if (ev.kind === 'town.rap' && (!d.offender || !d.kind)) {
      errs.push('town.rap requires data.offender and data.kind');
    }
    return errs;
  },
  viewer: { panels: [{ id: 'ledger', title: 'Learn Ledger', render: 'town-ledger' }] },
};
