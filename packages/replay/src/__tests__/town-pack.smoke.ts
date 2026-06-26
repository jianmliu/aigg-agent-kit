/**
 * Smoke for the town@0 pack's validation invariants.
 * Run: pnpm --filter @aigg/replay test:town
 */
import assert from 'node:assert/strict';
import type { Event, ValidateCtx, RunHeader } from '../schema';
import { townPack, TOWN_PACK_ID } from '../packs/town';

const ctx: ValidateCtx = {
  header: {} as RunHeader,
  entityIds: new Set(['npc:abao']), // pre-seeded for future actor-ref checks
};

function errs(ev: Event): string[] {
  return townPack.validateEvent?.(ev, ctx) ?? [];
}

assert.equal(TOWN_PACK_ID, 'town@0');
assert.deepEqual(townPack.eventKinds, ['town.talk', 'town.pitch', 'town.refuse', 'town.anchor', 'town.belief', 'town.warn', 'town.trust', 'town.propose', 'town.vote', 'town.sanction', 'town.lend', 'town.default', 'town.rap', 'town.crime']);

// town.talk verified:true needs an attestation signature
assert.equal(errs({ kind: 'town.talk', data: { verified: true, attestation: { signature: 'sig' } } }).length, 0, 'verified talk with sig ok');
assert.ok(errs({ kind: 'town.talk', data: { verified: true } }).length > 0, 'verified talk without attestation fails');
assert.equal(errs({ kind: 'town.talk', data: { verified: false } }).length, 0, 'unverified talk ok without attestation');

// town.refuse must be protected + reference a claim
assert.equal(errs({ kind: 'town.refuse', data: { protected: true, claim: 'c' } }).length, 0, 'good refuse ok');
assert.ok(errs({ kind: 'town.refuse', data: { protected: false, claim: 'c' } }).length > 0, 'refuse not protected fails');
assert.ok(errs({ kind: 'town.refuse', data: { protected: true } }).length > 0, 'refuse without claim fails');

// town.anchor must carry a beliefRoot
assert.equal(errs({ kind: 'town.anchor', data: { beliefRoot: '0xabc' } }).length, 0, 'anchor with root ok');
assert.ok(errs({ kind: 'town.anchor', data: {} }).length > 0, 'anchor without root fails');

// town.pitch is declared but carries no invariants yet
assert.equal(errs({ kind: 'town.pitch', data: {} }).length, 0, 'town.pitch has no constraints yet');

// town.vote requires choice of 'for' or 'against'
assert.equal(errs({ kind: 'town.vote', data: { choice: 'for' } }).length, 0, 'valid vote ok');
assert.ok(errs({ kind: 'town.vote', data: { choice: 'maybe' } }).length > 0, 'bad vote choice fails');

// town.sanction requires boolean data.passed
assert.equal(errs({ kind: 'town.sanction', data: { passed: true } }).length, 0, 'valid sanction ok');
assert.ok(errs({ kind: 'town.sanction', data: {} }).length > 0, 'sanction without passed fails');

assert.equal(errs({ kind: 'town.default', data: { owed: 11, recovered: 0 } }).length, 0, 'valid default ok');
assert.ok(errs({ kind: 'town.default', data: { owed: 11 } }).length > 0, 'default missing recovered fails');
assert.equal(errs({ kind: 'town.rap', data: { offender: 'visitor:1', kind: 'default' } }).length, 0, 'valid rap ok');
assert.ok(errs({ kind: 'town.rap', data: { offender: 'visitor:1' } }).length > 0, 'rap missing kind fails');

assert.equal(errs({ kind: 'town.crime', data: { offender: 'visitor:1', kind: 'sabotage', caught: true } }).length, 0, 'valid crime ok');
assert.ok(errs({ kind: 'town.crime', data: { offender: 'visitor:1', kind: 'sabotage' } }).length > 0, 'crime missing caught fails');
assert.ok(errs({ kind: 'town.crime', data: { offender: 'visitor:1', kind: 'sabotage', caught: 'yes' } }).length > 0, 'crime non-boolean caught fails');

// panel descriptor present
assert.equal(townPack.viewer?.panels[0].render, 'town-ledger');

console.log('ALL TOWN-PACK SMOKE TESTS PASSED ✅');
