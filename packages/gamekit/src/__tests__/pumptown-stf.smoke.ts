/**
 * pumptown-stf smoke — the pump-town ECONOMIC core on the same deterministic STF
 * (the high-stake, on-chain-executed subset per docs/WORLD_AS_DOMAIN.md §3).
 * Proves the AMM/trade/dividend txs are pure, conserve value, move price the right
 * way, and replay bit-for-bit — i.e. they are fraud-proof-ready for a `PumpWorld.sol`
 * port (this TS STF is that contract's reference implementation / differential oracle).
 *
 * Run: npx tsx src/__tests__/pumptown-stf.smoke.ts
 */
import assert from 'node:assert/strict';
import { DefaultGameRules } from '@onchainpal/npc-agent';
import { applyTx, applyAll, ammSwap, emptyWorld, stateRoot, type WorldState, type WorldTx } from '../stf/world-stf';

const rules = new DefaultGameRules();
const apply = (s: WorldState, tx: WorldTx) => applyTx(s, tx, rules).state;
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
const totalUsdc = (s: WorldState) => Object.values(s.usdc ?? {}).reduce((x, y) => x + y, 0) + (s.market?.usdcReserve ?? 0);
const totalGcc = (s: WorldState) => Object.values(s.balances ?? {}).reduce((x, y) => x + y, 0) + (s.market?.gccReserve ?? 0);

function test_initMarket_and_price() {
  const s = apply(emptyWorld(), { type: 'initMarket', gccReserve: 1000, usdcReserve: 100, supply: 1000 });
  assert.ok(s.market, 'market seeded');
  assert.equal(s.market!.gccReserve, 1000);
  assert.equal(s.market!.usdcReserve, 100);
  assert.ok(near(s.market!.usdcReserve / s.market!.gccReserve, 0.1), 'spot price = usdc/gcc = 0.1');
  console.log('  ✓ initMarket seeds the AMM; spot price = usdcReserve/gccReserve');
}

function test_buy_raises_price_and_conserves() {
  let s = apply(emptyWorld(), { type: 'initMarket', gccReserve: 1000, usdcReserve: 100, supply: 1000 });
  s.usdc = { a1: 50 };
  const p0 = s.market!.usdcReserve / s.market!.gccReserve;
  const kBefore = s.market!.gccReserve * s.market!.usdcReserve;
  const usdcBefore = totalUsdc(s), gccBefore = totalGcc(s);

  s = apply(s, { type: 'trade', agentId: 'a1', side: 'buy', amountIn: 10, now: 1 });
  const p1 = s.market!.usdcReserve / s.market!.gccReserve;
  assert.ok(p1 > p0, 'buying GCC raises price');
  assert.equal(s.usdc!.a1, 40, 'agent USDC -= amountIn (10)');
  assert.ok(s.balances.a1 > 0, 'agent receives GCC out');
  assert.ok(near(s.market!.gccReserve * s.market!.usdcReserve, kBefore), 'x·y=k preserved');
  assert.ok(near(totalUsdc(s), usdcBefore), 'USDC conserved (agent → reserve, none minted)');
  assert.ok(near(totalGcc(s), gccBefore), 'GCC conserved (reserve → agent)');
  console.log('  ✓ buy raises price, preserves k, conserves USDC+GCC (no minting)');
}

function test_sell_lowers_price_roundtrip() {
  let s = apply(emptyWorld(), { type: 'initMarket', gccReserve: 1000, usdcReserve: 100, supply: 1000 });
  s.usdc = { a1: 50 };
  s = apply(s, { type: 'trade', agentId: 'a1', side: 'buy', amountIn: 10, now: 1 });
  const gccHeld = s.balances.a1;
  const pAfterBuy = s.market!.usdcReserve / s.market!.gccReserve;
  s = apply(s, { type: 'trade', agentId: 'a1', side: 'sell', amountIn: gccHeld, now: 2 });
  const pAfterSell = s.market!.usdcReserve / s.market!.gccReserve;
  assert.ok(pAfterSell < pAfterBuy, 'selling lowers price back down');
  assert.ok(near(s.balances.a1, 0), 'agent sold all GCC back');
  // round-trip loses a little USDC to slippage (no fee, but price impact) → agent ≤ 50
  assert.ok(s.usdc!.a1 <= 50 + 1e-9 && s.usdc!.a1 > 40, 'round-trip returns ~USDC minus slippage');
  console.log('  ✓ sell lowers price; buy→sell round-trip costs slippage (≤ start)');
}

function test_dividend_pays_per_gcc() {
  let s = apply(emptyWorld(), { type: 'initMarket', gccReserve: 1000, usdcReserve: 100 });
  s.balances = { a1: 200, a2: 50 };
  s.usdc = { a1: 0, a2: 0 };
  const r = applyTx(s, { type: 'dividend', perGcc: 0.01 }, rules);
  assert.ok(near(r.state.usdc!.a1, 2), 'a1: 200 gcc × 0.01 = 2 USDC');
  assert.ok(near(r.state.usdc!.a2, 0.5), 'a2: 50 gcc × 0.01 = 0.5 USDC');
  const ev = r.events.find((e) => e.kind === 'dividend') as any;
  assert.ok(near(ev.totalPaid, 2.5), 'totalPaid = 2.5');
  console.log('  ✓ dividend pays perGcc × holdings to every GCC holder');
}

function test_rejects() {
  // trade with no market
  let r = applyTx(emptyWorld(), { type: 'trade', agentId: 'a1', side: 'buy', amountIn: 1, now: 1 }, rules);
  assert.equal(r.events[0].kind, 'rejected');
  assert.equal((r.events[0] as any).reason, 'no_market');
  // insufficient balance
  let s = apply(emptyWorld(), { type: 'initMarket', gccReserve: 1000, usdcReserve: 100 });
  r = applyTx(s, { type: 'trade', agentId: 'a1', side: 'buy', amountIn: 999, now: 1 }, rules);
  assert.equal((r.events[0] as any).reason, 'insufficient_usdc');
  console.log('  ✓ trade rejects: no_market / insufficient balance (no value created)');
}

function test_deterministic_replay() {
  const txs: WorldTx[] = [
    { type: 'initMarket', gccReserve: 1000, usdcReserve: 100, supply: 1000 },
    { type: 'trade', agentId: 'a1', side: 'buy', amountIn: 10, now: 1 },
    { type: 'trade', agentId: 'a2', side: 'buy', amountIn: 5, now: 2 },
    { type: 'dividend', perGcc: 0.001 },
    { type: 'trade', agentId: 'a1', side: 'sell', amountIn: 30, now: 3 },
  ];
  const seed = (): WorldState => ({ ...emptyWorld(), usdc: { a1: 50, a2: 20 } });
  const a = applyAll(seed(), txs, rules).state;
  const b = applyAll(seed(), txs, rules).state;
  assert.equal(stateRoot(a), stateRoot(b), 'same txs → identical state root (replayable, fraud-proof-ready)');
  console.log('  ✓ applyAll replays bit-for-bit → reproducible stateRoot');
}

// total USDC anywhere in the system: agent balances + AMM reserve + escrowed market pools
const totalUsdcAll = (s: WorldState) =>
  Object.values(s.usdc ?? {}).reduce((x, y) => x + y, 0) +
  (s.market?.usdcReserve ?? 0) +
  Object.values(s.markets ?? {}).reduce((x, m) => x + m.yesPool + m.noPool, 0);

function test_prediction_resolves_on_amm_price() {
  let s = apply(emptyWorld(), { type: 'initMarket', gccReserve: 1000, usdcReserve: 100, supply: 1000 });
  s.usdc = { a1: 50, a2: 50, whale: 200 };
  const usdc0 = totalUsdcAll(s);
  s = apply(s, { type: 'openMarket', marketId: 'm1', threshold: 0.15, now: 1 });
  s = apply(s, { type: 'bet', marketId: 'm1', agentId: 'a1', side: 'YES', amount: 20, now: 2 }); // YES pool 20
  s = apply(s, { type: 'bet', marketId: 'm1', agentId: 'a2', side: 'NO', amount: 30, now: 3 });  // NO pool 30
  assert.equal(s.usdc!.a1, 30, 'a1 staked 20 → 30 left'); assert.equal(s.usdc!.a2, 20, 'a2 staked 30 → 20 left');
  // whale buys → price climbs well above 0.15
  s = apply(s, { type: 'trade', agentId: 'whale', side: 'buy', amountIn: 100, now: 4 });
  const price = s.market!.usdcReserve / s.market!.gccReserve;
  assert.ok(price >= 0.15, 'price pushed above threshold → YES');
  s = apply(s, { type: 'resolveMarket', marketId: 'm1', now: 5 });
  const m = s.markets!.m1;
  assert.equal(m.status, 'resolved'); assert.equal(m.outcome, 'YES', 'resolved by the AMM price, not an oracle');
  assert.ok(near(s.usdc!.a1, 80), 'a1 (only YES staker) takes the whole 50 pool → 30 + 50 = 80');
  assert.equal(s.usdc!.a2, 20, 'a2 lost the NO stake (0 payout)');
  assert.ok(near(totalUsdcAll(s), usdc0), 'USDC conserved end-to-end (pool redistributed, none minted)');
  console.log('  ✓ prediction market resolves on the AMM price (internal, no oracle); parimutuel pro-rata; USDC conserved');
}

function test_prediction_refund_when_no_winners() {
  let s = apply(emptyWorld(), { type: 'initMarket', gccReserve: 1000, usdcReserve: 100 });
  s.usdc = { a1: 50, a2: 50 };
  s = apply(s, { type: 'openMarket', marketId: 'm2', threshold: 0.5, now: 1 }); // price 0.1, no trades → resolves NO
  s = apply(s, { type: 'bet', marketId: 'm2', agentId: 'a1', side: 'YES', amount: 20, now: 2 });
  s = apply(s, { type: 'bet', marketId: 'm2', agentId: 'a2', side: 'YES', amount: 10, now: 3 }); // nobody on NO
  s = apply(s, { type: 'resolveMarket', marketId: 'm2', now: 4 });
  assert.equal(s.markets!.m2.outcome, 'NO', 'price 0.1 < 0.5 → NO');
  assert.equal(s.usdc!.a1, 50, 'no NO-winners → a1 refunded'); assert.equal(s.usdc!.a2, 50, 'a2 refunded');
  console.log('  ✓ no winners on the resolved side → all stakes refunded (no value lost)');
}

function test_prediction_rejects() {
  let s = apply(emptyWorld(), { type: 'initMarket', gccReserve: 1000, usdcReserve: 100 });
  s.usdc = { a1: 50 };
  // bet on nonexistent market
  assert.equal((applyTx(s, { type: 'bet', marketId: 'nope', agentId: 'a1', side: 'YES', amount: 5, now: 1 }, rules).events[0] as any).reason, 'no_market');
  s = apply(s, { type: 'openMarket', marketId: 'm3', threshold: 0.05, now: 1 });
  s = apply(s, { type: 'bet', marketId: 'm3', agentId: 'a1', side: 'YES', amount: 5, now: 2 });
  s = apply(s, { type: 'resolveMarket', marketId: 'm3', now: 3 }); // price 0.1 >= 0.05 → YES
  // double resolve + bet after close
  assert.equal((applyTx(s, { type: 'resolveMarket', marketId: 'm3', now: 4 }, rules).events[0] as any).reason, 'already_resolved');
  assert.equal((applyTx(s, { type: 'bet', marketId: 'm3', agentId: 'a1', side: 'NO', amount: 5, now: 5 }, rules).events[0] as any).reason, 'market_closed');
  console.log('  ✓ rejects: no_market / already_resolved / market_closed');
}

function test_mud_world_untouched() {
  // a pure-MUD world never grows usdc/market keys → MUD stateRoot byte-identical to before
  const s = apply(emptyWorld(), { type: 'createNpc', id: 'npc:x', name: 'X', owner: 'u', room: 'r', background: 'b' });
  assert.equal(s.usdc, undefined, 'no usdc key in a MUD world');
  assert.equal(s.market, undefined, 'no market key in a MUD world');
  console.log('  ✓ pump-town fields are additive — pure-MUD worlds are unchanged');
}

function main() {
  console.log('=== pumptown-stf smoke (economic core on the deterministic STF) ===\n');
  test_initMarket_and_price();
  test_buy_raises_price_and_conserves();
  test_sell_lowers_price_roundtrip();
  test_dividend_pays_per_gcc();
  test_rejects();
  test_prediction_resolves_on_amm_price();
  test_prediction_refund_when_no_winners();
  test_prediction_rejects();
  test_deterministic_replay();
  test_mud_world_untouched();
  console.log('\nPUMPTOWN-STF SMOKE PASSED ✅');
}

main();
