/**
 * reflection-oracle smoke — observe → synthesize → exploit a learned type policy.
 * Run: tsx src/__tests__/reflection-oracle.smoke.ts
 */
import assert from 'node:assert/strict';
import { ReflectionOracle, type InferenceOracle, type OracleInput, type OracleOutput } from '../index';
import type { Effect } from '@onchainpal/npc-agent';

const inner: InferenceOracle = {
  async produce(): Promise<OracleOutput> {
    return { say: 'hi', gccCost: 0.05, effects: [{ kind: 'adjustRelationship', delta: 3, reason: 'x' } as Effect], usage: { model: 'm', inputTokens: 0, outputTokens: 0, gccCost: 0.05 } };
  },
};
const input = (type: string): OracleInput => ({ npcId: 'n', playerId: 'p', text: type, persona: { id: 'n', name: 'n', role: '', allowedEffects: [], caps: {}, addressing: [] } as any, balanceGcc: 100, rel: { affinity: 0, tags: [] } });

async function main() {
  const r = new ReflectionOracle({ inner, typeOf: (i) => i.text, every: 2, cost: 0.02 });

  // feed outcomes: 'bad' type earns ~nothing, 'good' type earns a lot (hidden — same output).
  for (let i = 0; i < 3; i++) { r.observe(input('bad'), 0.01); r.observe(input('good'), 0.5); }

  // before reflecting: no policy → engages (cost 0.05); the 2nd think triggers reflection (+0.02).
  let o = await r.produce(input('good')); assert.equal(o.gccCost, 0.05, 'pre-reflect: engages');
  o = await r.produce(input('good')); assert.ok(Math.abs(o.gccCost - 0.07) < 1e-9, 'reflection fires → +cost (0.05+0.02)');
  console.log('  ✓ reflects every N engaged thinks (synthesize, costs GCC)');

  // after reflection: skips the learned-low-value type, keeps the high-value one.
  o = await r.produce(input('bad')); assert.equal(o.gccCost, 0, 'learned bad-type value (0.01) < cost → rests');
  o = await r.produce(input('good')); assert.equal(o.gccCost, 0.05, 'high-value type still engaged');
  console.log('  ✓ exploits insight: rests on hidden-low-value type, engages high-value');

  console.log('\nREFLECTION-ORACLE SMOKE PASSED ✅');
}

main().catch((e) => { console.error('REFLECTION-ORACLE SMOKE FAILED ❌', e); process.exit(1); });
