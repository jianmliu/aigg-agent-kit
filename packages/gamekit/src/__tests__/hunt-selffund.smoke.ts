/**
 * Smoke: 端到端自给闭环 hunt → silver → exchangeSilverForGcc → GCC (Task B5)
 *
 * Verifies GCC conservation across the self-funding loop:
 *   1. hunt() mints silver — GCC does NOT change (conservation)
 *   2. exchangeSilverForGcc() bridges silver → GCC — ok:true, gotGcc > 0
 *   3. Final GCC == startGcc + gotGcc (GCC grew ONLY via the one-way exchange bridge)
 *
 * Run: npx tsx src/__tests__/hunt-selffund.smoke.ts
 */
import assert from 'node:assert/strict';
import { InMemoryStore } from '@aigg/npc-agent';
import { SharedWorld } from '../shared-world';

async function main() {
  const store = new InMemoryStore();
  // Minimal no-op provider stub — smoke never calls talk(), inference is never invoked.
  const provider = {
    id: 'stub',
    complete: async () => ({ text: '{}', usage: { model: 'stub', inputTokens: 0, outputTokens: 0, gccCost: 0 } }),
  };

  // Monster with a fixed high silver drop so there is always enough to exchange.
  const wild = {
    rooms: ['wilds:1'],
    bestiary: [{
      id: '弱鸡怪', maxHp: 1, atk: 1, def: 0, spirit: 0, element: '水' as const,
      drops: { silver: [50, 50] as [number, number], food: [1, 1] as [number, number] }
    }],
    spawns: { 'wilds:1': [{ species: '弱鸡怪', weight: 1 }] }
  };

  // Use the REAL SharedWorldOptions shape: eatAxis is a DIRECT top-level field (Task B3).
  // exchange config enables the one-way bridge with rate=100 (50 silver → 0.5 GCC).
  const w = new SharedWorld({
    store,
    provider,
    rooms: ['wilds:1'],
    wild,
    eatAxis: '食',
    exchange: { enabled: true, rate: 100, dailyCapSilver: 1000 },
  });

  // startGcc: 0 so the conservation check is unambiguous (any GCC would come from exchange only).
  await w.createNpc({ id: 'H', name: '猎手', owner: 'h', background: '武夫剑客', room: 'wilds:1', startGcc: 0, startSilver: 0 });

  // Give the hunter overwhelming stats so it always wins.
  await w.setCombat('H', { maxHp: 200, hp: 200, atk: 99, def: 50, spirit: 0, element: '火', skills: [] });

  // ── Step 1: record GCC before hunt ──────────────────────────────────────────
  const gccStart = await w.balanceGcc('H');

  // hunt with a fixed `now` seed for determinism; target the fixed-drop monster.
  const res = await w.hunt('H', '弱鸡怪', 1000);
  assert.equal(res.ok, true, 'hunt must succeed');
  assert.equal(res.outcome, 'win', 'strong hunter wins');
  assert.ok((res.yield?.silver ?? 0) >= 50, 'hunt mints at least 50 silver from fixed drop');

  // ── Step 2: GCC conservation — hunt is a silver/needs op, NOT a GCC op ─────
  const gccAfterHunt = await w.balanceGcc('H');
  assert.equal(gccAfterHunt, gccStart, 'hunt alone never mints GCC (conservation)');

  // Confirm silver balance rose so the exchange has something to spend.
  const silverAfterHunt = await w.balanceSilver('H');
  assert.ok(silverAfterHunt >= 50, 'silver balance reflects hunt yield');

  // ── Step 3: exchange silver → GCC via the one-way bridge ───────────────────
  const ex = await w.exchangeSilverForGcc({ npcId: 'H', silver: 50 });
  assert.equal(ex.ok, true, 'exchange ok');
  assert.ok(ex.gotGcc > 0, 'silver → GCC via the one-way bridge');

  // ── Step 4: GCC grew ONLY via exchange, by exactly the exchanged amount ─────
  const gccFinal = await w.balanceGcc('H');
  assert.equal(gccFinal, gccStart + ex.gotGcc, 'GCC grew ONLY via exchange (exact arithmetic)');

  console.log('HUNT-SELFFUND SMOKE PASSED ✅');
}

main().catch((err) => { console.error('HUNT-SELFFUND SMOKE FAILED ❌', err); process.exit(1); });
