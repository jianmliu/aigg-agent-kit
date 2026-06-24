/**
 * Smoke for the town@0 pack's validation invariants.
 * Run: pnpm --filter @onchainpal/replay test:town
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
assert.deepEqual(townPack.eventKinds, ['town.talk', 'town.pitch', 'town.refuse', 'town.anchor']);

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

// panel descriptor present
assert.equal(townPack.viewer?.panels[0].render, 'town-ledger');

console.log('ALL TOWN-PACK SMOKE TESTS PASSED ✅');
