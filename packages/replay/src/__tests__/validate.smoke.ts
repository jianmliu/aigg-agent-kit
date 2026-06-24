/**
 * Smoke for validateRun — core invariants + pack validation.
 * Run: pnpm --filter @onchainpal/replay test:validate
 */
import assert from 'node:assert/strict';
import { validateRun } from '../validate';

const header = {
  kind: 'run', schema: 'replay@1', runId: 'r1', createdAt: 0,
  packs: ['town@0'],
  entities: [{ id: 'npc:abao', name: 'A-Bao' }],
};
const J = (o: unknown) => JSON.stringify(o);

// a valid minimal town run
const good = [
  J(header),
  J({ kind: 'tick', t: 1, events: [{ kind: 'town.talk', actor: 'npc:abao', data: { verified: false } }] }),
  J({ kind: 'tick', t: 2, events: [{ kind: 'town.pitch', actor: 'npc:abao', data: { accepted: true, claim: 'c', deltaGcc: -3 } }] }),
  J({ kind: 'summary', town: { refusals: 0 } }),
];
assert.equal(validateRun(good).ok, true, 'valid run passes');

// header must be first + kind run
assert.equal(validateRun([J({ kind: 'tick', t: 1, events: [] })]).ok, false, 'missing header fails');

// unknown schema
assert.equal(validateRun([J({ ...header, schema: 'replay@9' })]).ok, false, 'unknown schema fails');

// unknown declared pack
assert.equal(validateRun([J({ ...header, packs: ['ghost@0'] })]).ok, false, 'unknown pack fails');

// t must strictly increase
const badT = [J(header), J({ kind: 'tick', t: 2, events: [] }), J({ kind: 'tick', t: 2, events: [] })];
assert.equal(validateRun(badT).ok, false, 'non-increasing t fails');

// unknown event kind (econ kind not declared in this run)
const badKind = [J(header), J({ kind: 'tick', t: 1, events: [{ kind: 'econ.pump' }] })];
assert.equal(validateRun(badKind).ok, false, 'undeclared event kind fails');

// pack invariant: verified talk without attestation
const badTalk = [J(header), J({ kind: 'tick', t: 1, events: [{ kind: 'town.talk', data: { verified: true } }] })];
const r = validateRun(badTalk);
assert.equal(r.ok, false, 'verified talk without attestation fails');
assert.ok(r.errors.some((e) => e.msg.includes('attestation')), 'error mentions attestation');

// summary not last
const badSummary = [J(header), J({ kind: 'summary' }), J({ kind: 'tick', t: 1, events: [] })];
assert.equal(validateRun(badSummary).ok, false, 'summary before ticks fails');

// core move/say always allowed even without declaring a pack
const coreOnly = [
  J({ ...header, packs: [] }),
  J({ kind: 'tick', t: 1, events: [{ kind: 'say', actor: 'npc:abao', data: { text: 'hi' } }] }),
];
assert.equal(validateRun(coreOnly).ok, true, 'core say allowed without domain packs');

console.log('ALL VALIDATE SMOKE TESTS PASSED ✅');
