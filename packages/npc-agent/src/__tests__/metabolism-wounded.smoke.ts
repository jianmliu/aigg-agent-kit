import assert from 'node:assert/strict';
import { Metabolism } from '../economy/metabolism';

const m = new Metabolism({
  tiers: [
    { id: 'opus', minBalanceGcc: 1, model: 'opus', label: '充盈' },
    { id: 'sonnet', minBalanceGcc: 0.1, model: 'sonnet', label: '清醒' },
    { id: 'haiku', minBalanceGcc: 0.005, model: 'haiku', label: '困倦' }
  ],
  starvingBelowGcc: 0.005, defaultTierId: 'sonnet'
});

assert.equal(m.decide(5).tier.id, 'opus', 'rich → opus');
assert.equal(m.decide(5, { wounded: true }).tier.id, 'sonnet', 'wounded clamps one notch down');
assert.equal(m.decide(0.2, { wounded: true }).tier.id, 'haiku', 'wounded clamps from sonnet to haiku');
assert.equal(m.decide(0.005, { wounded: true }).tier.id, 'haiku', 'lowest tier stays lowest');

console.log('METABOLISM-WOUNDED SMOKE PASSED ✅');
