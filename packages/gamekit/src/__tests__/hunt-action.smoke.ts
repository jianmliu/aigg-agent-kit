import assert from 'node:assert/strict';
import { huntAction } from '../actions/builtins';
import type { ActionContext } from '../actions/registry';

const base: ActionContext = {
  npcId: 'H', persona: { id: 'H', name: '猎手', role: '' } as any, room: 'wilds:1',
  npcsInRoom: [], balanceGcc: 1, balanceSilver: 0, needs: { 食: 10 }, ricePrice: null, now: 1
};

assert.equal(huntAction.available({ ...base, inWild: true, productionIntent: true }), true, 'wild + intent → available');
assert.equal(huntAction.available({ ...base, inWild: false, productionIntent: true }), false, 'not wild → unavailable');
assert.equal(huntAction.available({ ...base, inWild: true }), true, 'wild + hungry(needs low) → available');

const out = huntAction.resolve({ ...base, inWild: true }, { species: '林中野狼' });
assert.ok(typeof out.sharedWorldOp === 'function', 'resolve returns a sharedWorldOp');
assert.deepEqual(out.effects, [], 'no STF effects (op-driven)');

console.log('HUNT-ACTION SMOKE PASSED ✅');
