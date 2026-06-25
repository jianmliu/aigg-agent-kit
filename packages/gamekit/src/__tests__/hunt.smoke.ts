/**
 * Smoke: SharedWorld.hunt — 狩猎生产闭环 (Task B3)
 *
 * Verifies:
 *   - strong hunter (atk 99) wins against weak monster
 *   - silver yield is minted (balanceSilver rises by the fixed-range drop)
 *   - GCC is unchanged by hunt (conservation — hunt is a silver/needs op, not GCC)
 *   - hunt is deterministic: same now → same rounds
 *
 * Run: npx tsx src/__tests__/hunt.smoke.ts
 */
import assert from 'node:assert/strict';
import { InMemoryStore } from '@onchainpal/npc-agent';
import { SharedWorld } from '../shared-world';

async function main() {
  const store = new InMemoryStore();
  // SharedWorldOptions requires `provider` — supply a minimal no-op stub.
  // The smoke never calls talk(), so inference is never invoked.
  const provider = {
    id: 'stub',
    complete: async () => ({ text: '{}', usage: { model: 'stub', inputTokens: 0, outputTokens: 0, gccCost: 0 } }),
  };

  const wild = {
    rooms: ['wilds:1'],
    bestiary: [{
      id: '弱鸡怪', maxHp: 1, atk: 1, def: 0, spirit: 0, element: '水' as const,
      drops: { silver: [5, 5] as [number, number], food: [4, 4] as [number, number] }
    }],
    spawns: { 'wilds:1': [{ species: '弱鸡怪', weight: 1 }] }
  };

  const w = new SharedWorld({ store, provider, rooms: ['wilds:1'], wild, eatAxis: '食' });

  await w.createNpc({ id: 'H', name: '猎手', owner: 'h', background: '武夫剑客', room: 'wilds:1', startGcc: 1, startSilver: 0 });

  // 让猎手必胜:拔高属性
  await w.setCombat('H', { maxHp: 200, hp: 200, atk: 99, def: 50, spirit: 0, element: '火', skills: [] });

  const gcc0 = await w.balanceGcc('H');
  const res = await w.hunt('H');
  assert.equal(res.ok, true, 'hunt ok');
  assert.equal(res.outcome, 'win', 'strong hunter wins');
  assert.ok(res.yield!.silver === 5, 'mints fixed-range silver yield');
  assert.equal(res.balanceSilver, 5, 'silver minted to hunter');
  assert.equal(await w.balanceGcc('H'), gcc0, 'GCC unchanged by hunt (conservation)');

  // 确定性:同 now+ids → 同 rounds(注入 now)
  const r1 = await w.hunt('H', '弱鸡怪', 1000);
  const r2 = await w.hunt('H', '弱鸡怪', 1000);
  assert.deepEqual(r1.rounds, r2.rounds, 'hunt deterministic for same seed inputs');

  console.log('HUNT SMOKE PASSED ✅');
}

main().catch((err) => { console.error('HUNT SMOKE FAILED ❌', err); process.exit(1); });
