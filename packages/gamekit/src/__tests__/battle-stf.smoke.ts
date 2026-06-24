import assert from 'node:assert/strict';
import { applyTx, emptyWorld, type WorldState, type WorldTx } from '../stf/world-stf';
import { DefaultGameRules } from '@onchainpal/npc-agent';
import type { CombatStats } from '../stf/combat-types';

const rules = new DefaultGameRules(() => undefined);
const mk = (o: Partial<CombatStats>): CombatStats => ({ maxHp: 100, hp: 100, atk: 15, def: 8, spirit: 5, element: '水', skills: [], ...o });

function world(): WorldState {
  const w = emptyWorld();
  w.npcs['A'] = { id: 'A', name: '甲', owner: 'h', room: 'wilds:1', background: '武夫', status: 'active' };
  w.npcs['M'] = { id: 'M', name: '乙', owner: 'h', room: 'wilds:1', background: '凡人', status: 'active' };
  w.balances['A'] = 5; w.balances['M'] = 5;
  w.combat = { A: mk({ atk: 22 }), M: mk({ atk: 8, hp: 40 }) };
  return w;
}

// 1) 确定性重放:同 (state, tx) → 完全一致
const tx: WorldTx = { type: 'battle', attackerId: 'A', defender: { kind: 'npc', id: 'M' }, seed: 777, now: 10 };
const r1 = applyTx(world(), tx, rules);
const r2 = applyTx(world(), tx, rules);
assert.deepEqual(r1.events, r2.events, 'battle replays bit-for-bit');

// 2) GCC 守恒
assert.equal(r1.state.balances['A'], 5, 'attacker GCC untouched');
assert.equal(r1.state.balances['M'], 5, 'defender GCC untouched');

// 3) 败者重伤:hp 降 + woundedUntil 写
const ev = r1.events.find(e => (e as any).kind === 'battle') as any;
assert.ok(ev, 'emits battle event');
const loser = ev.loserId;
assert.ok(r1.state.combat![loser].hp < r1.state.combat![loser].maxHp, 'loser took damage (hp < maxHp)');
assert.equal(r1.state.combat![loser].woundedUntil, 10 + 3, 'woundedUntil = now + WOUND_TICKS');

// 4) NPC↔NPC 世仇:双向好感都更负
assert.ok(ev.affinity.ab < 0 && ev.affinity.ba < 0, 'duel deepens grudge both ways');

// 5) 怪物路径:defender=monster,属性挂 tx,怪不入 state
const wm = world(); delete wm.npcs['M']; delete (wm.combat as any).M;
const txM: WorldTx = { type: 'battle', attackerId: 'A', seed: 5, now: 20,
  defender: { kind: 'monster', species: '林中野狼', stats: mk({ atk: 9, hp: 30 }) } };
const rm = applyTx(wm, txM, rules);
const evM = rm.events.find(e => (e as any).kind === 'battle') as any;
assert.equal(evM.defenderRef, 'monster:林中野狼', 'monster ref');
assert.ok(!('monster:林中野狼' in (rm.state.combat ?? {})), 'monster not persisted');
assert.equal(evM.affinity, undefined, 'no grudge vs monster');

console.log('BATTLE-STF SMOKE PASSED ✅');
