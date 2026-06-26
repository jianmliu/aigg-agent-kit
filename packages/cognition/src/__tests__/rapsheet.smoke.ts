/** Smoke for RapSheet. Run: pnpm --filter @aigg/cognition test:rapsheet */
import assert from 'node:assert/strict';
import { RapSheet } from '../society/rapsheet';

const r = new RapSheet();
assert.equal(r.has('v'), false, 'clean offender → has false');
assert.equal(r.count('v'), 0, 'clean offender → count 0');
assert.deepEqual(r.entries('v'), [], 'clean offender → no entries');

r.record('v', { kind: 'default', victim: 'npc:han', t: 1 });
assert.equal(r.has('v'), true, 'one record → has true');
assert.equal(r.count('v'), 1);

r.record('v', { kind: 'default', victim: 'npc:liu', t: 2 });
assert.equal(r.count('v'), 2, 'second record appends');
assert.equal(r.entries('v')[1].victim, 'npc:liu', 'entries ordered');

assert.equal(r.has('other'), false, 'per-offender isolation');
console.log('ALL RAPSHEET SMOKE TESTS PASSED ✅');
