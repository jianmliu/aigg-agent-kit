/**
 * needs-world smoke (spec 里程碑①B/C/E) — SharedWorld 接线 + 生产/消费基本面,
 * offline (no server/LLM, pure store + AMM):
 *   1. tickNeeds:在「满足房间」一 tick 后对应轴上升;离开后只衰减(降);
 *   2. needsOf 读回手动写入的低值态(talk 注入路径的前置);
 *   3. 生产岗 sell shock → 市场供给增、价跌;消费 buy(进食)→ 供给减、价回;
 *      satisfyNeed 回填食轴;全程 x·y=k 守恒。
 *
 * Run: npx tsx src/__tests__/needs-world.smoke.ts
 */
import assert from 'node:assert/strict';
import { SharedWorld } from '../shared-world';
import { FairTick } from '../fair';
import { InMemoryStore, Metabolism, type InferenceProvider, type InferenceResult, type NeedsConfig } from '@onchainpal/npc-agent';

class Scripted implements InferenceProvider {
  readonly id = 'scripted';
  async complete(): Promise<InferenceResult> {
    return { text: '好。', usage: { model: 's', inputTokens: 1, outputTokens: 1, gccCost: 0 } };
  }
}

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

async function main() {
  const rich = new Metabolism({ tiers: [{ id: 'r', minBalanceGcc: 0, model: 'm', label: '充盈' }], starvingBelowGcc: -1, defaultTierId: 'r' });
  // 需求 def:食轴 decay 5;在「酒馆」每 tick 满足食 +20。
  const needs: NeedsConfig = { axes: { 食: { decayPerTick: 5, threshold: 30 } }, satisfy: { 酒馆: { 食: 20 } } };
  const world = new SharedWorld({ store: new InMemoryStore(), provider: new Scripted(), metabolism: rich, needs });
  const mk = (name: string, gcc: number) => world.createNpc({ name, owner: 'host:pal', background: '镇民', room: '广场', startGcc: gcc });
  const dwarf = await mk('丁大伯', 50);

  // --- 1. 满足房间一 tick 升;离开降 ---
  // 起点:广场(不满足)→ 食轴从 100 起衰减
  let ns = (await world.tickNeeds(dwarf))!;
  assert.equal(ns.食, 95, '广场:食 100 → 衰减 5 = 95(缺轴补 100 再衰)');
  ns = (await world.tickNeeds(dwarf))!;
  assert.equal(ns.食, 90, '广场再一拍 → 90(纯衰减)');

  // 走进酒馆:衰减 5 再满足 +20 → 净升 +15
  await world.place(dwarf, '酒馆');
  ns = (await world.tickNeeds(dwarf))!;
  assert.equal(ns.食, 100, '酒馆:90 -5(衰) +20(满足) = 105 clamp 100 → 该轴升');

  // 离开回广场:只衰减
  await world.place(dwarf, '广场');
  ns = (await world.tickNeeds(dwarf))!;
  assert.equal(ns.食, 95, '离开满足房间 → 该轴只衰减(降)');
  console.log('  ✓ 满足房间一 tick 食轴升(→100),离开后只衰减(→95)');

  // --- 2. needsOf 读回低态(talk 注入前置)---
  await world.satisfyNeed(dwarf, '食', -90);  // 压到低位(satisfy 接受负 amount → 减)
  const low = await world.needsOf(dwarf);
  assert.ok((low.食 ?? 100) < 30, 'needsOf 读回压低后的食轴 < 阈值(summarize 会注入)');
  console.log(`  ✓ needsOf 读回低食态(${low.食}),< 阈值 → talk 会注入【需求】`);

  // --- 3. 生产/消费基本面 ---
  await world.initRiceMarket({ rice: 1000, silver: 500 });
  const k0 = 1000 * 500;
  assert.equal(await world.ricePrice(), 0.5, '初始米价 0.5');

  // 生产岗:方老板囤米 200,sell shock 50 → 市场供给增、价跌
  const fang = await mk('方老板', 100);
  await world.grantRice(fang, 200);
  await world.place(fang, '集市');
  // 消费者:一个食轴低的镇民,在集市(= marketRoom)有银两
  const eater = await mk('饿汉', 50);
  await world.place(eater, '集市');
  await world.satisfyNeed(eater, '食', -95);   // 食 ≈ 5,饿

  const fair = new FairTick(world, [], { marketRoom: '集市', shocks: [{ tick: 1, npcId: fang, side: 'sell', amount: 50, label: '产出' }] });
  await fair.runTick(0);
  const before = (await world.riceMarket())!;
  const t1 = await fair.runTick(1);
  const prod = t1.trades.find((x) => x.shock === '产出');
  assert.ok(prod && prod.side === 'sell', '生产岗向市场供给(sell)');
  const afterProd = (await world.riceMarket())!;
  assert.ok(afterProd.riceReserve > before.riceReserve, '供给增:米储上升');
  assert.ok(afterProd.silverReserve < before.silverReserve, '价跌:银储下降(米价走低)');
  assert.ok(close(afterProd.riceReserve * afterProd.silverReserve, k0), 'k 守恒(生产 sell)');
  const priceAfterProd = afterProd.silverReserve / afterProd.riceReserve;
  console.log(`  ✓ 生产岗 sell 50 → 米储增、米价 0.5 → ${priceAfterProd.toFixed(4)}(供给增价跌),k 不变`);

  // 消费:饿汉进食 = 从市场 buy → 抽走供给、价回
  const buy = await world.tradeRice({ npcId: eater, side: 'buy', amount: 10 });
  assert.equal(buy.ok, true, '饿汉有银两,进食成交');
  await world.satisfyNeed(eater, '食', 40);
  const afterEat = (await world.riceMarket())!;
  assert.ok(afterEat.riceReserve < afterProd.riceReserve, '消费减:米储下降(抽走供给)');
  assert.ok(close(afterEat.riceReserve * afterEat.silverReserve, k0), 'k 守恒(消费 buy)');
  const priceAfterEat = afterEat.silverReserve / afterEat.riceReserve;
  assert.ok(priceAfterEat > priceAfterProd, '消费抽走供给 → 米价回升');
  assert.ok((await world.needsOf(eater)).食! >= 30, 'satisfyNeed 回填食轴(进食后不再饿)');
  console.log(`  ✓ 消费 buy 10(进食)→ 米储减、米价 ${priceAfterProd.toFixed(4)} → ${priceAfterEat.toFixed(4)}(价回),k 不变`);

  console.log('\nNEEDS-WORLD SMOKE PASSED ✅');
}

main().catch((e) => { console.error('NEEDS-WORLD SMOKE FAILED ❌', e); process.exit(1); });
