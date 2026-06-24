import { parseRun, activePanels, townLedger } from './viewer-core.js';

const $meta = document.getElementById('meta');
const $timeline = document.getElementById('timeline');
const $panels = document.getElementById('panels');

// render id → DOM renderer
const RENDERERS = {
  'entity-graph': (run) => {
    const el = panelEl('Entities');
    for (const e of run.header.entities || []) {
      const row = document.createElement('div');
      row.className = 'npc';
      row.innerHTML = `<span>${esc(e.name)}</span><span class="muted">${esc(e.kind || '')}</span>`;
      el.appendChild(row);
    }
    return el;
  },
  'town-ledger': (run) => {
    const el = panelEl('Learn Ledger');
    const model = townLedger(run);
    for (const n of model.npcs) {
      const row = document.createElement('div');
      row.className = 'npc';
      const seal = n.verifiedTalks ? `<span class="seal" title="TEE-verified thoughts">● ${n.verifiedTalks}</span>` : '';
      row.innerHTML = `<span>${esc(n.id)}</span> ${seal} <span class="bal">${n.balanceGcc ?? '—'} $0G · burned ${n.burned} · refused ${n.refusals}</span>`;
      el.appendChild(row);
    }
    for (const b of model.beliefs) {
      const card = document.createElement('div');
      card.className = 'belief';
      card.innerHTML = `<div>${esc(b.belief)}</div>${b.beliefRoot ? `<div class="root">0G Storage · ${esc(b.beliefRoot)}</div>` : ''}`;
      el.appendChild(card);
    }
    return el;
  },
  'econ-price': () => notice('econ@0 price panel — not implemented this cycle'),
  'econ-wealth': () => notice('econ@0 wealth panel — not implemented this cycle'),
};

function panelEl(title) {
  const el = document.createElement('div');
  el.className = 'panel';
  const h = document.createElement('h2');
  h.textContent = title;
  el.appendChild(h);
  return el;
}
function notice(text) {
  const el = panelEl('Panel');
  const p = document.createElement('div');
  p.className = 'notice';
  p.textContent = text;
  el.appendChild(p);
  return el;
}
function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

function render(run) {
  $meta.textContent = `${run.header.title || run.header.runId} · packs: ${(run.header.packs || []).join(', ') || '(core only)'}`;
  // timeline
  $timeline.innerHTML = '';
  for (const tick of run.ticks) {
    for (const ev of tick.events || []) {
      const d = document.createElement('div');
      d.className = 'ev';
      d.innerHTML = `<span class="k">t${tick.t} · ${esc(ev.kind)}</span> ${esc(ev.actor || '')}`;
      $timeline.appendChild(d);
    }
  }
  // panels (core always; declared packs; unknown packs degrade silently to core)
  $panels.innerHTML = '';
  for (const spec of activePanels(run.header)) {
    const fn = RENDERERS[spec.render];
    $panels.appendChild(fn ? fn(run) : notice(`pack panel "${spec.render}" not installed`));
  }
}

document.getElementById('file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  render(parseRun(await file.text()));
});

// auto-load ?run=<url> (e.g. /replay/?run=latest.jsonl when served by 0gtown)
const runUrl = new URLSearchParams(location.search).get('run');
if (runUrl) {
  fetch(runUrl).then((r) => r.text()).then((t) => render(parseRun(t))).catch(() => {
    $meta.textContent = `failed to load ${runUrl}`;
  });
}
