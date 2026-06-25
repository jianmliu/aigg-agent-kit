// Pure replay logic shared by the browser viewer — no DOM, unit-tested under tsx.

// Panel registry mirrors the TS pack viewer.panels specs. The `render` id is the
// contract: viewer.js maps each id to a DOM render function.
export const PACK_PANELS = {
  'core@0': [{ id: 'graph', title: 'Entities', render: 'entity-graph' }],
  'town@0': [{ id: 'ledger', title: 'Learn Ledger', render: 'town-ledger' }],
  'econ@0': [
    { id: 'price', title: 'Price', render: 'econ-price' },
    { id: 'wealth', title: 'Wealth', render: 'econ-wealth' },
  ],
};

/** Parse a JSONL run string into { header, ticks, summary }. */
export function parseRun(text) {
  const lines = text.trim().split('\n').filter((l) => l.length);
  const objs = lines.map((l) => JSON.parse(l));
  const header = objs[0];
  const summary = objs.length && objs[objs.length - 1].kind === 'summary' ? objs[objs.length - 1] : null;
  const ticks = objs.filter((o) => o.kind === 'tick');
  return { header, ticks, summary };
}

/** Lightweight structural guard for the viewer (NOT the authoritative validator,
 *  which lives in the TS package). Returns an error string, or null if the run
 *  looks renderable. */
export function runError(run) {
  if (!run || !run.header || run.header.kind !== 'run') return 'not a replay run (missing run header)';
  if (run.header.schema !== 'replay@1') return `unsupported schema: ${run.header.schema ?? '(none)'}`;
  if (!Array.isArray(run.header.entities)) return 'run header has no entities';
  return null;
}

/** Core panel always present; known declared packs light up; unknown packs ignored. */
export function activePanels(header) {
  const panels = [...PACK_PANELS['core@0']];
  for (const id of header.packs || []) {
    if (PACK_PANELS[id]) panels.push(...PACK_PANELS[id]);
  }
  return panels;
}

/** Build the town Learn-Ledger model: per-NPC balances + belief cards. */
export function townLedger(run) {
  const npcs = new Map();
  const beliefs = [];
  const warnings = [];   // town.trust deltas, newest last
  const guild = [];   // governance events: proposals, votes, sanctions (newest last)
  const ensure = (id) => {
    if (!npcs.has(id)) npcs.set(id, { id, balanceGcc: null, verifiedTalks: 0, burned: 0, refusals: 0, warnings: 0 });
    return npcs.get(id);
  };
  for (const e of run.header.entities || []) if (e.kind === 'npc') ensure(e.id);

  for (const tick of run.ticks) {
    for (const ev of tick.events || []) {
      const d = ev.data || {};
      const n = ev.actor ? ensure(ev.actor) : null;
      if (!n) continue;
      if (typeof d.balanceGcc === 'number') n.balanceGcc = d.balanceGcc;
      if (ev.kind === 'town.talk' && d.verified) n.verifiedTalks++;
      if (ev.kind === 'town.pitch' && d.accepted) n.burned++;
      if (ev.kind === 'town.refuse') n.refusals++;
      if ((ev.kind === 'town.anchor' || ev.kind === 'town.refuse') && d.belief) {
        beliefs.push({ npc: ev.actor, claim: d.claim, belief: d.belief, beliefRoot: d.beliefRoot, t: tick.t });
      }
      if (ev.kind === 'town.warn' && d.accepted) n.warnings = (n.warnings || 0) + 1;
      if (ev.kind === 'town.trust') {
        warnings.push({ npc: ev.actor, peer: d.peer, value: d.value, t: tick.t });
      }
      if (ev.kind === 'town.propose') guild.push({ kind: 'propose', proposer: ev.actor, target: d.target, topic: d.topic, t: tick.t });
      if (ev.kind === 'town.vote') guild.push({ kind: 'vote', voter: ev.actor, choice: d.choice, t: tick.t });
      if (ev.kind === 'town.sanction') guild.push({ kind: 'sanction', target: d.target, passed: d.passed, shareFor: d.shareFor, t: tick.t });
    }
  }
  return { npcs: [...npcs.values()], beliefs, warnings, guild };
}
