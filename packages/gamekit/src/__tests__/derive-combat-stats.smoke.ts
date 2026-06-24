import assert from 'node:assert/strict';
import { deriveCombatStats } from '../stf/derive-combat-stats';

const s1 = deriveCombatStats('酒剑仙,御剑而行的醉侠');
const s2 = deriveCombatStats('酒剑仙,御剑而行的醉侠');
assert.deepEqual(s1, s2, 'deterministic for same background');
assert.equal(s1.hp, s1.maxHp, 'starts full hp');
assert.ok(s1.atk > 0 && s1.def > 0 && s1.maxHp > 0, 'positive stats');
assert.ok(['风','雷','水','火','土'].includes(s1.element), 'valid element');
assert.notDeepEqual(s1, deriveCombatStats('李大娘,余杭客栈的老板娘'), 'different background → different stats');

console.log('DERIVE-COMBAT-STATS SMOKE PASSED ✅');
