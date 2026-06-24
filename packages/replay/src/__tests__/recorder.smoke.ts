/**
 * Smoke for createRecorder — roundtrip emit → validateRun ok, and guardrails.
 * Run: pnpm --filter @onchainpal/replay test:recorder
 */
import assert from 'node:assert/strict';
import { createRecorder } from '../recorder';
import { validateRun } from '../validate';

// capture lines via a custom sink (no filesystem)
const lines: string[] = [];
const rec = createRecorder({ write: (l) => lines.push(l), packs: ['town@0'] });

rec.run({ runId: 'r1', entities: [{ id: 'npc:abao', name: 'A-Bao' }], meta: { liveMode: true } });
rec.tick(1);
rec.event('town.talk', { actor: 'npc:abao', data: { verified: true, attestation: { signature: '0g-teeml:verified:x', model: 'glm-5-fp8' }, costGcc: 0.001 } });
rec.metrics({ 'receipts.compute': 1 });
rec.tick(2);
rec.event('town.pitch', { actor: 'npc:abao', data: { accepted: true, claim: 'c', deltaGcc: -3 } });
rec.summary({ town: { refusals: 0 } });
rec.close();

const res = validateRun(lines);
assert.equal(res.ok, true, `recorded stream validates: ${JSON.stringify(res.errors)}`);
assert.equal(JSON.parse(lines[0]).schema, 'replay@1', 'header schema stamped');
assert.equal(JSON.parse(lines[0]).packs[0], 'town@0', 'packs carried from opts');

// guardrail: undeclared event kind throws
assert.throws(() => {
  const r2 = createRecorder({ write: () => {}, packs: ['town@0'] });
  r2.run({ runId: 'r2', entities: [{ id: 'x', name: 'X' }] });
  r2.tick(1);
  r2.event('econ.pump');
}, /undeclared event kind/, 'undeclared kind rejected');

// guardrail: event before tick throws
assert.throws(() => {
  const r3 = createRecorder({ write: () => {}, packs: ['town@0'] });
  r3.run({ runId: 'r3', entities: [{ id: 'x', name: 'X' }] });
  r3.event('town.talk');
}, /before tick/, 'event before tick rejected');

console.log('ALL RECORDER SMOKE TESTS PASSED ✅');
