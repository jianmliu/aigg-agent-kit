/**
 * rice-bets smoke — 赌坊 offline (pure STF path, no server/LLM):
 *   1. open 「今秋米价过 0.55?」→ bets escrow 银两 into the pools;
 *   2. 风浪 shock pushes the rice price ABOVE threshold → resolve → YES wins,
 *      parimutuel pro-rata (losers fund winners), total 银两 conserved;
 *   3. no-winner market → full refund; rejection paths (no market / closed /
 *      insufficient / double resolve / resolve without AMM).
 *
 * Run: npx tsx src/__tests__/rice-bets.smoke.ts
 */
import assert from 'node:assert/strict';
import { SharedWorld } from '../shared-world';
import { InMemoryStore, Metabolism, type InferenceProvider, type InferenceResult } from '@onchainpal/npc-agent';

class Scripted implements InferenceProvider {
  readonly id = 'scripted';
  async complete(): Promise<InferenceResult> {
    return { text: '好。', usage: { model: 's', inputTokens: 1, outputTokens: 1, gccCost: 0 } };
  }
}
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

async function main() {
  const rich = new Metabolism({ tiers: [{ id: 'r', minBalanceGcc: 0, model: 'm', label: '充盈' }], starvingBelowGcc: -1, defaultTierId: 'r' });
  const world = new SharedWorld({ store: new InMemoryStore(), provider: new Scripted(), metabolism: rich });
  const mk = (name: string, gcc: number) => world.createNpc({ name, owner: 'host:pal', background: '赌客', room: '苏州赌场', startGcc: gcc });
  const haoke = await mk('賭客甲', 30);   // bets YES
  const dugui = await mk('賭鬼', 30);     // bets NO (and more)
  const whale = await mk('方老板', 200);  // the shock trader

  // resolve without any AMM → rejected
  await world.openRiceBet({ marketId: 'pre', threshold: 0.5 });
  let rr = await world.resolveRiceBet('pre');
  assert.equal(rr.ok, false);
  assert.equal(rr.reason, 'no_amm_price', 'no AMM yet → cannot resolve');

  await world.initRiceMarket({ rice: 1000, silver: 500 });   // 米价 0.5
  await world.grantRice(whale, 100);

  // 1. open + escrow
  const open = await world.openRiceBet({ marketId: 'qiushou', threshold: 0.55 });
  assert.equal(open.ok, true);
  assert.equal((await world.openRiceBet({ marketId: 'qiushou', threshold: 0.6 })).reason, 'market_exists', 'no double open');

  let b = await world.placeRiceBet({ npcId: haoke, marketId: 'qiushou', side: 'YES', amount: 10 });
  assert.equal(b.ok, true);
  assert.ok(close(b.balanceGcc, 20), 'stake escrowed out of the bettor');
  b = await world.placeRiceBet({ npcId: dugui, marketId: 'qiushou', side: 'NO', amount: 20 });
  assert.equal(b.ok, true);
  assert.ok(close(b.yesPool, 10) && close(b.noPool, 20), 'pools reflect the stakes');
  assert.equal((await world.placeRiceBet({ npcId: dugui, marketId: 'qiushou', side: 'NO', amount: 999 })).reason, 'insufficient_usdc', 'cannot bet what you do not have');
  console.log('  ✓ 开盘 + 下注 escrow(银两入池,池账相符,超注被拒)');

  // 2. 风浪 shock: whale buys rice hard → price ≥ 0.55 → resolve → YES wins
  const shock = await world.tradeRice({ npcId: whale, side: 'buy', amount: 40 });
  assert.ok(shock.ok && shock.price >= 0.55, `风浪扫货抬价: ${shock.price.toFixed(4)} ≥ 0.55`);
  const before = (await world.balanceGcc(haoke)) + (await world.balanceGcc(dugui));
  rr = await world.resolveRiceBet('qiushou');
  assert.equal(rr.ok, true);
  assert.equal(rr.outcome, 'YES', 'resolved by the AMM price itself');
  assert.ok(close(rr.totalPool!, 30) && close(rr.payouts!, 30), 'whole pool paid out');
  const haokeAfter = await world.balanceGcc(haoke);
  const duguiAfter = await world.balanceGcc(dugui);
  assert.ok(close(haokeAfter, 20 + 30), 'YES staker takes the WHOLE pool pro-rata (10/10 × 30)');
  assert.ok(close(duguiAfter, 10), 'NO staker funded the winner');
  assert.ok(close(haokeAfter + duguiAfter, before + 30), '银两 conserved: escrow → payouts exactly');
  assert.equal((await world.resolveRiceBet('qiushou')).reason, 'already_resolved', 'no double resolve');
  const resolved = (await world.riceBets())['qiushou'];
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.outcome, 'YES');
  console.log(`  ✓ 风浪抬价 → 按米市自身价格自证 YES → 平注 pro-rata,银两守恒,盘口收档`);

  // 3. no-winner refund: everyone on the losing side
  await world.openRiceBet({ marketId: 'refund', threshold: 99 });   // YES impossible
  await world.placeRiceBet({ npcId: haoke, marketId: 'refund', side: 'YES', amount: 5 });
  const preRefund = await world.balanceGcc(haoke);
  rr = await world.resolveRiceBet('refund');
  assert.equal(rr.ok, true);
  assert.equal(rr.outcome, 'NO');
  assert.ok(close(await world.balanceGcc(haoke), preRefund + 5), 'no winners → full refund');
  console.log('  ✓ 无赢家 → 全额退款(池守恒)');

  // closed-market bet rejected
  assert.equal((await world.placeRiceBet({ npcId: haoke, marketId: 'qiushou', side: 'YES', amount: 1 })).reason, 'market_closed');
  assert.equal((await world.placeRiceBet({ npcId: haoke, marketId: 'nope', side: 'YES', amount: 1 })).reason, 'no_market');
  console.log('  ✓ 拒绝路径: 已收档/无此盘');

  console.log('\nRICE-BETS SMOKE PASSED ✅');
}

main().catch((e) => { console.error('RICE-BETS SMOKE FAILED ❌', e); process.exit(1); });
