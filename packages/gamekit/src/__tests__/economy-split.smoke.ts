/**
 * economy-split smoke (spec docs/specs/economy-split.md) — 算力(GCC)与游戏货币
 * (银两)分离 + 单向兑换桥,offline(no server/LLM,pure store + AMM):
 *   1. silver 增减 + clamp;createNpc startSilver / 默认底;
 *   2. **分离铁律**:一串 tradeRice(买卖)后 balanceGcc 逐字不变,只动 balanceSilver;
 *   3. AMM k(米储×银储)守恒;
 *   4. 赌注走 silver(下注扣 / 赔付加,GCC 不变);
 *   5. 生产/消费走 silver(生产岗卖米赚 silver、进食花 silver,GCC 不变);
 *   6. 兑换桥(单向):扣 silver 加 GCC + 每日上限拒超额 + disabled 拒 + 无反向接口。
 *
 * Run: npx tsx src/__tests__/economy-split.smoke.ts
 */
import assert from 'node:assert/strict';
import { SharedWorld } from '../shared-world';
import { FairTick } from '../fair';
import { InMemoryStore, Metabolism, type InferenceProvider, type InferenceResult, type NeedsConfig } from '@aigg/npc-agent';

class Scripted implements InferenceProvider {
  readonly id = 'scripted';
  // talk 不烧 GCC(gccCost:0)—— 才能断言「一串交易后 balanceGcc 逐字不变」。
  async complete(): Promise<InferenceResult> {
    return { text: '好。', usage: { model: 's', inputTokens: 1, outputTokens: 1, gccCost: 0 } };
  }
}

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

async function main() {
  const rich = new Metabolism({ tiers: [{ id: 'r', minBalanceGcc: 0, model: 'm', label: '充盈' }], starvingBelowGcc: -1, defaultTierId: 'r' });
  // 食轴 def(生产/消费段用):在「集市」每 tick 满足食 +20。
  const needs: NeedsConfig = { axes: { 食: { decayPerTick: 5, threshold: 30 } }, satisfy: { 集市: { 食: 20 } } };
  const world = new SharedWorld({
    store: new InMemoryStore(), provider: new Scripted(), metabolism: rich, needs,
    exchange: { enabled: true, rate: 100, dailyCapSilver: 50 }
  });
  const mk = (name: string, gcc: number, silver?: number) =>
    world.createNpc({ name, owner: 'host:pal', background: '镇民', room: '集市', startGcc: gcc, ...(silver != null ? { startSilver: silver } : {}) });

  // --- 1. silver 增减 + clamp + startSilver / 默认底 ---
  const a = await mk('丁大伯', 5, 20);
  assert.equal(await world.balanceSilver(a), 20, 'startSilver=20 → 银两 20');
  assert.equal(await world.grantSilver(a, 5), 25, 'grantSilver +5 → 25');
  assert.equal(await world.grantSilver(a, -100), 0, '减到负 → clamp 0');
  assert.equal(await world.grantSilver(a, 10), 10, '再发 10 → 10');
  const dflt = await mk('阿默', 5);   // 不给 startSilver
  assert.equal(await world.balanceSilver(dflt), 10, 'createNpc 不给 startSilver → 默认底 10');
  console.log('  ✓ silver 增减 + clamp≥0;startSilver 与默认底 10');

  // --- 1b. 暖启动迁移回填:经济分离前落盘、从无 silverKey 的旧 NPC ---
  // 用裸 store 写一个「迁移前」NPC(有 npcKey+gccKey,无 silverKey)模拟生产暖持久化。
  const migStore = new InMemoryStore();
  const wmig = new SharedWorld({ store: migStore, provider: new Scripted(), metabolism: rich });
  const W = { type: 'world' as const };
  await migStore.set(W, 'npc:npc:旧户', { id: 'npc:旧户', name: '旧户', owner: 'host:pal', room: '集市', background: '镇民', status: 'active' });
  await migStore.set(W, 'npc:npc:旧户:gcc', 0.01);
  assert.equal(await wmig.balanceSilver('npc:旧户'), 0, '迁移前:silverKey 缺失 → balanceSilver 读 0(正是 bug)');
  assert.equal(await wmig.backfillSilver('npc:旧户', 10), true, 'backfill:缺 silverKey → 实际回填 true');
  assert.equal(await wmig.balanceSilver('npc:旧户'), 10, '回填后 → 默认底 10,可买米');
  // 幂等:再调不动账(已有 silverKey,含合法的 0)。
  assert.equal(await wmig.backfillSilver('npc:旧户', 10), false, 'backfill 二次:已有 silverKey → false 不回填');
  await wmig.grantSilver('npc:旧户', -10);   // 交易归零 = 合法穷 NPC
  assert.equal(await wmig.balanceSilver('npc:旧户'), 0, '归零后 silver=0');
  assert.equal(await wmig.backfillSilver('npc:旧户', 10), false, 'backfill 对合法的 0 不反复回填(判据=缺键,非 ===0)');
  assert.equal(await wmig.balanceSilver('npc:旧户'), 0, '合法穷 NPC 余额不被回填覆盖');
  console.log('  ✓ 暖启动迁移回填:缺键补默认底 + 幂等 + 不覆盖合法的 0');

  // --- 2. 分离铁律:一串 tradeRice 后 balanceGcc 逐字不变,只动 silver ---
  await world.initRiceMarket({ rice: 1000, silver: 500 });   // 米价 0.5
  const k0 = 1000 * 500;
  const trader = await mk('米贩', 0.01234, 100);
  const gcc0 = await world.balanceGcc(trader);                // = startGcc 逐字
  await world.tradeRice({ npcId: trader, side: 'buy', amount: 10 });
  await world.tradeRice({ npcId: trader, side: 'buy', amount: 5 });
  const afterBuy = await world.balanceSilver(trader);
  assert.ok(afterBuy < 100, 'buy 扣 silver');
  const buyHolding = await world.riceHolding(trader);
  await world.tradeRice({ npcId: trader, side: 'sell', amount: buyHolding });
  assert.ok((await world.balanceSilver(trader)) > afterBuy, 'sell 加 silver');
  // 关键:GCC 逐字不变(交易完全没碰思考燃料)
  assert.equal(await world.balanceGcc(trader), gcc0, '★ 一串买卖后 balanceGcc 逐字不变(经济分离)');
  console.log(`  ✓ 分离铁律:tradeRice 只动 silver,balanceGcc 逐字 ${gcc0} 不变`);

  // --- 3. AMM k(米储×银储)守恒 ---
  const m = (await world.riceMarket())!;
  assert.ok(close(m.riceReserve * m.silverReserve, k0), 'AMM k = 米储×银储 守恒');
  console.log('  ✓ AMM k 守恒(riceReserve × silverReserve)');

  // --- 4. 赌注走 silver(GCC 不变)---
  const bettor = await mk('赌客', 7, 30);
  const bg0 = await world.balanceGcc(bettor);
  await world.openRiceBet({ marketId: 'q', threshold: 0.55 });
  const placed = await world.placeRiceBet({ npcId: bettor, marketId: 'q', side: 'YES', amount: 10 });
  assert.equal(placed.ok, true);
  assert.equal(placed.balanceSilver, 20, '下注扣本金(银两 30 → 20)');
  assert.equal(await world.balanceGcc(bettor), bg0, '下注 GCC 不变');
  // 拉高米价过线 → resolve YES → 独赢回整池
  const whale = await mk('鲸鱼', 0, 1000);
  const wbuy = await world.tradeRice({ npcId: whale, side: 'buy', amount: 200 });
  assert.ok(wbuy.ok && wbuy.price! >= 0.55, `鲸鱼扫货抬价过线: ${wbuy.price?.toFixed(4)}`);
  const rr = await world.resolveRiceBet('q');
  assert.equal(rr.ok, true);
  assert.equal(rr.outcome, 'YES', '米价过线 → YES');
  assert.equal(await world.balanceSilver(bettor), 30, '独赢回整池(20 + 10)');
  assert.equal(await world.balanceGcc(bettor), bg0, '赔付 GCC 仍不变');
  console.log('  ✓ 赌注/赔付走 silver,GCC 全程不变');

  // --- 5. 生产/消费走 silver(GCC 不变)---
  const producer = await mk('方老板', 3, 0);
  await world.grantRice(producer, 200);
  const pg0 = await world.balanceGcc(producer);
  const eater = await mk('饿汉', 9, 50);
  const eg0 = await world.balanceGcc(eater);
  await world.satisfyNeed(eater, '食', -95);
  const fair = new FairTick(world, [], { marketRoom: '集市', shocks: [{ tick: 1, npcId: producer, side: 'sell', amount: 50, label: '产出' }] });
  const prodSilver0 = await world.balanceSilver(producer);
  await fair.runTick(0);
  await fair.runTick(1);   // 生产岗 sell shock → 卖米赚 silver
  assert.ok((await world.balanceSilver(producer)) > prodSilver0, '生产岗卖米 → silver 增');
  assert.equal(await world.balanceGcc(producer), pg0, '生产 GCC 不变');
  const eatSilver0 = await world.balanceSilver(eater);
  const buy = await world.tradeRice({ npcId: eater, side: 'buy', amount: 10 });  // 进食 = buy
  assert.equal(buy.ok, true, '饿汉有银两,进食成交');
  assert.ok((await world.balanceSilver(eater)) < eatSilver0, '进食 → silver 减');
  assert.equal(await world.balanceGcc(eater), eg0, '消费 GCC 不变');
  console.log('  ✓ 生产卖米赚 silver、进食花 silver,两者 GCC 不变');

  // --- 6. 兑换桥(单向 银两→GCC)+ 门控 ---
  const ex = await mk('勤工', 0, 100);
  const exGcc0 = await world.balanceGcc(ex);
  const r1 = await world.exchangeSilverForGcc({ npcId: ex, silver: 30 });
  assert.equal(r1.ok, true);
  assert.equal(r1.balanceSilver, 70, '兑换扣 30 银两');
  assert.ok(close(r1.gotGcc, 30 / 100), 'rate=100 → 得 0.3 GCC');
  assert.ok(close(r1.balanceGcc, exGcc0 + 30 / 100), 'GCC 加兑得');
  // 门控:再换 30 → 当日累计 60 > dailyCapSilver(50)→ 拒,余额不动
  const r2 = await world.exchangeSilverForGcc({ npcId: ex, silver: 30 });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'daily_cap', '超每日上限 → 拒');
  assert.equal(await world.balanceSilver(ex), 70, '被拒后银两不动');
  assert.equal(await world.balanceGcc(ex), r1.balanceGcc, '被拒后 GCC 不动');
  // 余额不足 / 非法金额
  assert.equal((await world.exchangeSilverForGcc({ npcId: ex, silver: 999 })).reason, 'insufficient_silver', '超余额拒');
  assert.equal((await world.exchangeSilverForGcc({ npcId: ex, silver: 0 })).reason, 'bad_amount', '零额拒');
  console.log('  ✓ 兑换桥扣 silver 加 GCC;每日上限/余额/金额门控拒超额');

  // disabled 世界 → exchange_disabled
  const off = new SharedWorld({ store: new InMemoryStore(), provider: new Scripted(), metabolism: rich });
  const offId = await off.createNpc({ name: '关桥', owner: 'host:pal', background: '镇民', startSilver: 50 });
  assert.equal((await off.exchangeSilverForGcc({ npcId: offId, silver: 10 })).reason, 'exchange_disabled', '未声明 exchange → 默认关');
  console.log('  ✓ 未声明 exchange 的世界 → 兑换桥默认关闭');

  // --- 7. 单向铁律:无反向接口 ---
  assert.equal((world as unknown as Record<string, unknown>).exchangeGccForSilver, undefined, '★ 无反向方法 exchangeGccForSilver');
  console.log('  ✓ 单向铁律:类上不存在 exchangeGccForSilver');

  console.log('\nECONOMY-SPLIT SMOKE PASSED ✅');
}

main().catch((e) => { console.error('economy-split FAILED ❌', e); process.exit(1); });
