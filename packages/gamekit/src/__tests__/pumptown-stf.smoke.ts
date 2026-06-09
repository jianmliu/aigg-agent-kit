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
  test_deterministic_replay();
  test_mud_world_untouched();
  console.log('\nPUMPTOWN-STF SMOKE PASSED ✅');
}

main();
