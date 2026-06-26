/**
 * Smoke: SharedWorld 战斗属性存取 + createNpc 派生
 *
 * Verifies:
 *   - createNpc seeds full-hp CombatStats in the store (hp === maxHp)
 *   - combatOf is a stable read (two calls return deepEqual result)
 *   - setCombat persists (mutated hp reads back)
 *
 * Run: npx tsx src/__tests__/combat-store.smoke.ts
 */
import assert from 'node:assert/strict';
import { InMemoryStore } from '@aigg/npc-agent';
import { SharedWorld } from '../shared-world';

async function main() {
  const store = new InMemoryStore();
  // SharedWorldOptions requires `provider` — supply a minimal no-op stub.
  // The smoke never calls talk(), so inference is never invoked.
  const provider = {
    id: 'stub',
    complete: async () => ({ text: '{}', usage: { model: 'stub', inputTokens: 0, outputTokens: 0, gccCost: 0 } }),
  };

  const w = new SharedWorld({ store, provider, rooms: ['wilds:1'] });

  await w.createNpc({
    id: 'A',
    name: '甲',
    owner: 'h',
    background: '御剑而行的醉侠',
    room: 'wilds:1',
    startGcc: 1,
  });

  const s = await w.combatOf('A');
  assert.ok(s.maxHp > 0, 'maxHp > 0');
  assert.equal(s.hp, s.maxHp, 'createNpc seeded full-hp combat stats');

  const s2 = await w.combatOf('A');
  assert.deepEqual(s, s2, 'stable read — combatOf returns the same value twice');

  await w.setCombat('A', { ...s, hp: 3, woundedUntil: 99 });
  const s3 = await w.combatOf('A');
  assert.equal(s3.hp, 3, 'setCombat persists — mutated hp reads back');
  assert.equal(s3.woundedUntil, 99, 'setCombat persists — woundedUntil reads back');

  console.log('COMBAT-STORE SMOKE PASSED ✅');
}

main().catch((err) => { console.error('COMBAT-STORE SMOKE FAILED ❌', err); process.exit(1); });
