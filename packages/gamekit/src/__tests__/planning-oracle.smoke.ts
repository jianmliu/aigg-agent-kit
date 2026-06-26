/**
 * planning-oracle smoke — the PLANNING faculty's two foresight rules.
 * Run: tsx src/__tests__/planning-oracle.smoke.ts
 */
import assert from 'node:assert/strict';
import { PlanningOracle, type InferenceOracle, type OracleInput, type OracleOutput } from '../index';
import type { Effect } from '@aigg/npc-agent';

const mkInner = (delta: number, cost: number): InferenceOracle => ({
  async produce(): Promise<OracleOutput> {
    return { say: 'hi', gccCost: cost, effects: [{ kind: 'adjustRelationship', delta, reason: 'x' } as Effect], usage: { model: 'm', inputTokens: 0, outputTokens: 0, gccCost: cost } };
  },
});
const input = (balanceGcc: number): OracleInput => ({ npcId: 'n', playerId: 'p', text: 'hi', persona: { id: 'n', name: 'n', role: '', allowedEffects: [], caps: {}, addressing: [] } as any, balanceGcc, rel: { affinity: 0, tags: [] } });
const earn = (rate: number) => (o: OracleOutput) => rate * o.effects.reduce((s, e: any) => s + (e.kind === 'adjustRelationship' ? e.delta : 0), 0);

async function main() {
  // value rule: think pays for itself (earn 0.02×3=0.06 > cost 0.05) → think.
  let p = new PlanningOracle({ inner: mkInner(3, 0.05), value: earn(0.02) });
  let out = await p.produce(input(10));
  assert.equal(out.gccCost, 0.05); assert.equal((out.effects[0] as any).delta, 3);
  console.log('  ✓ value rule: worth it (earn>cost) → thinks');

  // value rule: not worth it (earn 0.02×1=0.02 < cost 0.05) → rest (no cost, no effects).
  p = new PlanningOracle({ inner: mkInner(1, 0.05), value: earn(0.02) });
  out = await p.produce(input(10));
  assert.equal(out.gccCost, 0); assert.equal(out.effects.length, 0);
  console.log('  ✓ value rule: net-negative think → rests (skips the bleed)');

  // reserve rule: a think would breach the buffer → rest.
  p = new PlanningOracle({ inner: mkInner(3, 0.05), reserve: 9.98 });
  out = await p.produce(input(10)); // 10 − 0.05 = 9.95 < 9.98
  assert.equal(out.gccCost, 0);
  out = await p.produce(input(100)); // plenty of runway → think
  assert.equal(out.gccCost, 0.05);
  console.log('  ✓ reserve rule: rests when a think breaches buffer, thinks with runway');

  console.log('\nPLANNING-ORACLE SMOKE PASSED ✅');
}

main().catch((e) => { console.error('PLANNING-ORACLE SMOKE FAILED ❌', e); process.exit(1); });
