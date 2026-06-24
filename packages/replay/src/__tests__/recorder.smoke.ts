/**
 * Smoke for createRecorder — roundtrip emit → validateRun ok, and guardrails.
 * Run: pnpm --filter @onchainpal/replay test:recorder
 */
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
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

// close() without summary() must still flush the last buffered tick
const lines2: string[] = [];
const r4 = createRecorder({ write: (l) => lines2.push(l), packs: [] });
r4.run({ runId: 'r4', entities: [{ id: 'x', name: 'X' }] });
r4.tick(1);
r4.event('move');
r4.close();
assert.equal(lines2.length, 2, 'run header + tick flushed by close()');
assert.equal(JSON.parse(lines2[1]).kind, 'tick', 'last tick written on close()');
// writing after close() throws
assert.throws(() => r4.tick(2), /already closed/, 'tick after close rejected');

// path-based sink: writes a real file that validates and round-trips
const tmp = join(tmpdir(), 'replay-recorder-smoke.jsonl');
const rf = createRecorder({ path: tmp, packs: ['town@0'] });
rf.run({ runId: 'rf', entities: [{ id: 'npc:abao', name: 'A-Bao' }] });
rf.tick(1);
rf.event('town.talk', { actor: 'npc:abao', data: { verified: false } });
rf.close();
// the path sink writes via an async stream; wait for the flush to land on disk
let back: string[] = [];
for (let i = 0; i < 100; i++) {
  if (existsSync(tmp)) {
    back = readFileSync(tmp, 'utf8').trim().split('\n').filter((l) => l.length);
    if (back.length >= 2) break;
  }
  await sleep(10);
}
assert.equal(back.length, 2, 'file header + tick flushed to disk');
assert.equal(JSON.parse(back[0]).schema, 'replay@1', 'file header written');
assert.equal(validateRun(back).ok, true, 'file-sink stream validates');
rmSync(tmp, { force: true });

console.log('ALL RECORDER SMOKE TESTS PASSED ✅');
