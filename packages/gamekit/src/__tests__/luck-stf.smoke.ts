/**
 * luck-stf smoke — the exogenous-shock primitive for Talent-vs-Luck.
 *
 * Proves: (1) luckEvent applies multiplicative & additive shocks deterministically
 * (clamped ≥0), recording the realized luck score; (2) a seeded luck stream is
 * REPRODUCIBLE — same seed → identical balances → identical stateRoot (the
 * counterfactual-replay property); a different seed diverges.
 *
 * Run: tsx src/__tests__/luck-stf.smoke.ts
 */
import assert from 'node:assert/strict';
import { applyTx, applyAll, stateRoot, emptyWorld, mulberry32, rollLuck, type WorldState, type WorldTx } from '../index';
import { DefaultGameRules } from '@aigg/npc-agent';

const rules = new DefaultGameRules(() => undefined);
const seedWorld = (ids: string[], bal: number): WorldState => {
  let s = emptyWorld();
  for (const id of ids) {
    s = applyTx(s, { type: 'createNpc', id, name: id, owner: 'o', room: 'r', background: 'b' }, rules).state;
    s = applyTx(s, { type: 'donate', npcId: id, amountGcc: bal }, rules).state;
  }
  return s;
};

function main() {
  // ── 1. semantics: multiplicative + additive + clamp + realized-score event ──
  let s = seedWorld(['a'], 1.0);
  let r = applyTx(s, { type: 'luckEvent', npcId: 'a', gccFactor: 1.5, now: 1 }, rules);
  assert.ok(Math.abs(r.state.balances['a'] - 1.5) < 1e-9, 'mul good ×1.5');
  const luckEv = r.events.find((e) => e.kind === 'luck') as any;
  assert.equal(luckEv.gccBefore, 1.0); assert.ok(Math.abs(luckEv.gccAfter - 1.5) < 1e-9, 'luck event records realized score');

  r = applyTx(r.state, { type: 'luckEvent', npcId: 'a', gccFactor: 0.5, now: 2 }, rules);
  assert.ok(Math.abs(r.state.balances['a'] - 0.75) < 1e-9, 'mul bad ×0.5');
  r = applyTx(r.state, { type: 'luckEvent', npcId: 'a', gccDelta: -0.5, now: 3 }, rules);
  assert.ok(Math.abs(r.state.balances['a'] - 0.25) < 1e-9, 'add bad −0.5');
  r = applyTx(r.state, { type: 'luckEvent', npcId: 'a', gccDelta: -999, now: 4 }, rules);
  assert.equal(r.state.balances['a'], 0, 'clamped ≥0 (no negative wealth)');
  console.log('  ✓ luckEvent: mul/add shocks, clamp ≥0, realized-score event');

  // ── 2. seeded stream → reproducible (same seed → same stateRoot) ────────────
  const npcs = ['a', 'b', 'c', 'd'];
  const cfg = { mode: 'mul' as const, prob: 0.6, good: 1.5, bad: 0.6, goodBias: 0.5 };
  const run = (seed: number): WorldState => {
    const rng = mulberry32(seed);
    let st = seedWorld(npcs, 1.0);
    const txs: WorldTx[] = [];
    for (let t = 0; t < 30; t++) for (const id of npcs) { const tx = rollLuck(rng, id, cfg, t); if (tx) txs.push(tx); }
    return applyAll(st, txs, rules).state;
  };
  const root1 = stateRoot(run(42));
  const root2 = stateRoot(run(42));
  const rootX = stateRoot(run(43));
  assert.equal(root1, root2, 'same seed → identical stateRoot (reproducible)');
  assert.notEqual(root1, rootX, 'different seed → divergent outcome');
  console.log('  ✓ seeded luck stream reproducible: seed 42 ≡ 42, ≠ 43');

  console.log('\nLUCK-STF SMOKE PASSED ✅');
}

main();
