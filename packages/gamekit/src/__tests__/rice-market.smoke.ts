/**
 * rice-market smoke — 余杭米市 offline (no server/LLM, pure STF path):
 *   1. init → spot 米价 = 银储/米储; trade preserves x·y=k and conserves
 *      totals (no minting: agent+reserve sums constant on both legs);
 *   2. rejection paths: no market / insufficient 银两 / insufficient 米 —
 *      ok:false with the STF's reason, nothing moves;
 *   3. FairTick traders: a scripted 秋收 shock dumps rice → price drops →
 *      the momentum trader sells, the contrarian buys (deterministic signal).
 *
 * Run: npx tsx src/__tests__/rice-market.smoke.ts
 */
import assert from 'node:assert/strict';
import { SharedWorld } from '../shared-world';
import { FairTick } from '../fair';
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
  const mk = (name: string, gcc: number) => world.createNpc({ name, owner: 'host:pal', background: '镇民', room: '余杭集市', startGcc: gcc });
  const ding = await mk('丁大伯', 50);

  // 1. no market yet → trade rejected
  let r = await world.tradeRice({ npcId: ding, side: 'buy', amount: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_market', 'no market → rejected, nothing moves');

  // init: 米仓 1000 石 × 银储 500 两 → 米价 0.5
  await world.initRiceMarket({ rice: 1000, silver: 500 });
  assert.equal(await world.ricePrice(), 0.5, '米价 = 银储/米储');

  // 2. 囤米: x·y=k + conservation
  const k0 = 1000 * 500;
  r = await world.tradeRice({ npcId: ding, side: 'buy', amount: 10 });
  assert.equal(r.ok, true);
  const m1 = (await world.riceMarket())!;
  assert.ok(close(m1.gccReserve * m1.usdcReserve, k0), 'x·y=k preserved');
  assert.ok(close(m1.usdcReserve, 510), '银两 entered the reserve');
  assert.ok(close(r.balanceGcc, 40), '银两 left the agent');
  assert.ok(close(r.rice + m1.gccReserve, 1000), '米 conserved (agent+reserve)');
  assert.ok(r.price > 0.5, '囤米抬价');
  console.log(`  ✓ 囤米 10 两 → 得米 ${r.out.toFixed(4)} 石,米价 0.5 → ${r.price.toFixed(4)},k 不变`);

  // 抛米 round-trip conserves both ledgers
  const sell = await world.tradeRice({ npcId: ding, side: 'sell', amount: r.out });
  const m2 = (await world.riceMarket())!;
  assert.equal(sell.ok, true);
  assert.ok(close(m2.gccReserve * m2.usdcReserve, k0), 'k preserved after sell');
  assert.ok(close(sell.rice, 0), 'rice holding back to 0');
  assert.ok(close(sell.balanceGcc, 50), 'silver fully restored (float path: no fee)');
  console.log('  ✓ 抛米回程: 双账守恒,k 不变');

  // 3. insufficient paths
  r = await world.tradeRice({ npcId: ding, side: 'buy', amount: 999 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'insufficient_usdc', '银两不足 → rejected');
  r = await world.tradeRice({ npcId: ding, side: 'sell', amount: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'insufficient_gcc', '无米可抛 → rejected');
  console.log('  ✓ 拒绝路径: 无市/银两不足/无米,分文不动');

  // 4. FairTick traders: 秋收 shock dumps rice → momentum sells, contrarian buys
  const fang = await mk('方老板', 100);
  await world.grantRice(fang, 200);
  const momo = await mk('张四', 30);
  await world.grantRice(momo, 20);
  const contra = await mk('渔翁', 30);
  await world.grantRice(contra, 20);
  const fair = new FairTick(world, [
    { npcId: momo, role: 'trader', style: 'momentum', tradeAmount: 2 },
    { npcId: contra, role: 'trader', style: 'contrarian', tradeAmount: 2 }
  ], { shocks: [{ tick: 1, npcId: fang, side: 'sell', amount: 100, label: '秋收' }] });

  const t0 = await fair.runTick(0);                  // traders observe the baseline
  assert.equal(t0.trades.length, 0, 'tick0: no signal yet');
  const t1 = await fair.runTick(1);                  // 秋收 dump → price drops → signals fire
  const shock = t1.trades.find((x) => x.shock === '秋收');
  assert.ok(shock && shock.side === 'sell', 'the harvest dumped rice');
  const momoTrade = t1.trades.find((x) => x.npcId === momo);
  const contraTrade = t1.trades.find((x) => x.npcId === contra);
  assert.ok(momoTrade && momoTrade.side === 'sell', 'price fell → momentum sells');
  assert.ok(contraTrade && contraTrade.side === 'buy', 'price fell → contrarian buys');
  const mEnd = (await world.riceMarket())!;
  assert.ok(close(mEnd.gccReserve * mEnd.usdcReserve, k0), 'k preserved through the whole fair');
  console.log('  ✓ FairTick: 秋收抛米 → 价跌 → momentum 抛 / contrarian 囤;全程 k 不变');

  console.log('\nRICE-MARKET SMOKE PASSED ✅');
}

main().catch((e) => { console.error('RICE-MARKET SMOKE FAILED ❌', e); process.exit(1); });
