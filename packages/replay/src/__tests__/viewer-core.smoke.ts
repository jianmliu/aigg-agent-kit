/**
 * Smoke for the viewer's pure core (parse + panel selection + town ledger model).
 * Run: pnpm --filter @onchainpal/replay test:viewer
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const mod = await import(fileURLToPath(new URL('../../viewer/viewer-core.js', import.meta.url)));
const { parseRun, activePanels, townLedger, runError } = mod;

const text = [
  JSON.stringify({ kind: 'run', schema: 'replay@1', runId: 'r', createdAt: 0, packs: ['town@0'], entities: [{ id: 'npc:abao', name: 'A-Bao' }] }),
  JSON.stringify({ kind: 'tick', t: 1, events: [{ kind: 'town.talk', actor: 'npc:abao', data: { verified: true, balanceGcc: 9.9 } }] }),
  JSON.stringify({ kind: 'tick', t: 2, events: [{ kind: 'town.pitch', actor: 'npc:abao', data: { accepted: true, claim: 'c', deltaGcc: -3, balanceGcc: 6.9 } }] }),
  JSON.stringify({ kind: 'tick', t: 3, events: [{ kind: 'town.refuse', actor: 'npc:abao', data: { protected: true, claim: 'c', belief: 'learned', beliefRoot: '0xbeef' } }] }),
  JSON.stringify({ kind: 'summary', town: { refusals: 1 } }),
].join('\n');

const run = parseRun(text);
assert.equal(run.header.runId, 'r', 'header parsed');
assert.equal(run.ticks.length, 3, 'three ticks');
assert.ok(run.summary, 'summary parsed');

// always include the core panel; light up town; do not include econ
const panels = activePanels(run.header).map((p: any) => p.render);
assert.ok(panels.includes('entity-graph'), 'core panel always present');
assert.ok(panels.includes('town-ledger'), 'town panel lit up');
assert.ok(!panels.includes('econ-price'), 'econ panel not present');

// unknown pack → core only (graceful degradation)
const corePanels = activePanels({ ...run.header, packs: ['mystery@9'] }).map((p: any) => p.render);
assert.deepEqual(corePanels, ['entity-graph'], 'unknown pack degrades to core only');

// town ledger model: per-NPC balance + belief cards
const ledger = townLedger(run);
const abao = ledger.npcs.find((n: any) => n.id === 'npc:abao');
assert.equal(abao.balanceGcc, 6.9, 'latest balance tracked');
assert.equal(abao.verifiedTalks, 1, 'verified talk counted');
assert.equal(ledger.beliefs.length, 1, 'one belief card');
assert.equal(ledger.beliefs[0].beliefRoot, '0xbeef', 'belief root captured');

assert.equal(runError(parseRun(text)), null, 'valid run passes the guard');
assert.ok(runError({ header: { kind: 'tick' } }), 'non-run header rejected');
assert.ok(runError(parseRun(JSON.stringify({ kind: 'run', schema: 'pumptown/replay@0', entities: [] }))), 'foreign schema rejected');

console.log('ALL VIEWER-CORE SMOKE TESTS PASSED ✅');
