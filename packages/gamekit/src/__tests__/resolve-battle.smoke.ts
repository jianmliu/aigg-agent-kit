import assert from 'node:assert/strict';
import { resolveBattle } from '../stf/resolve-battle';
import { PLACEHOLDER_RESTRAINT, type CombatStats } from '../stf/combat-types';

const mk = (over: Partial<CombatStats>): CombatStats =>
  ({ maxHp: 100, hp: 100, atk: 15, def: 8, spirit: 5, element: '水', skills: [], ...over });

const a = { id: 'A', stats: mk({ atk: 20 }) };
const b = { id: 'B', stats: mk({ atk: 8, hp: 40 }) };

// 1) 确定性 golden:同 (stats, seed) → 逐字节相同
const r1 = resolveBattle(a, b, 12345, PLACEHOLDER_RESTRAINT);
const r2 = resolveBattle(a, b, 12345, PLACEHOLDER_RESTRAINT);
assert.deepEqual(r1, r2, 'same seed → identical result');

// 2) 不同 seed → 至少伤害序列不同(掷点生效)
const r3 = resolveBattle(a, b, 999, PLACEHOLDER_RESTRAINT);
assert.notDeepEqual(r1.rounds.map(x => x.damage), r3.rounds.map(x => x.damage), 'seed changes rolls');

// 3) 强者必胜(golden):A(atk 20, hp 100)碾压 B(atk 8, hp 40),seed 12345 下 A 确定性胜出
assert.equal(r1.winnerId, 'A', 'stronger combatant (A) wins');
assert.equal(r1.loserId, r1.winnerId === 'A' ? 'B' : 'A', 'loser is the other');

console.log('RESOLVE-BATTLE SMOKE PASSED ✅');
