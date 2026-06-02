/**
 * Headless smoke test for GccLedger — the per-NPC virtual GCC sub-ledger.
 * Run: pnpm --filter @onchainpal/npc-agent test:gcc
 */
import assert from 'node:assert/strict';
import { GccLedger, InMemoryStore, type InferenceUsage } from '../index';

const usage = (gcc: number, inTok = 100, outTok = 20): InferenceUsage => ({
  model: 'm',
  inputTokens: inTok,
  outputTokens: outTok,
  gccCost: gcc
});

const JX = 'npc:jiu-jianxian';
const AZ = 'npc:azhu';

async function main() {
  const store = new InMemoryStore();
  let clock = 1000;
  const ledger = new GccLedger(store, () => clock++);

  // 酒剑仙 thinks 3 times, 阿珠 once
  await ledger.record(JX, usage(0.0003));
  await ledger.record(JX, usage(0.0002));
  const jx = await ledger.record(JX, usage(0.0005, 200, 50));
  await ledger.record(AZ, usage(0.0001));

  assert.equal(jx.calls, 3, '酒剑仙 metered 3 calls');
  assert.ok(Math.abs(jx.gccSpent - 0.001) < 1e-9, 'gccSpent accumulates (0.0003+0.0002+0.0005)');
  assert.equal(jx.inputTokens, 400, 'input tokens accumulate');
  assert.equal(jx.outputTokens, 90, 'output tokens accumulate');
  assert.equal(jx.lastAt, 1002, 'lastAt from injected clock');

  const az = await ledger.get(AZ);
  assert.equal(az.calls, 1, 'per-NPC isolation: 阿珠 separate');
  assert.ok(Math.abs(az.gccSpent - 0.0001) < 1e-9);

  // persistence: a fresh ledger over the same store sees the totals
  const ledger2 = new GccLedger(store);
  const jx2 = await ledger2.get(JX);
  assert.equal(jx2.calls, 3, 'ledger survives via the store');

  // onchain-tagged (this is the GCC-consumption record)
  assert.ok([...store.onchainKeys].some((k) => k.includes('gcc-ledger')), 'ledger writes tagged onchain');

  // unknown NPC → zero
  const none = await ledger.get('npc:nobody');
  assert.equal(none.gccSpent, 0, 'unknown NPC reads zero');

  console.log('✓ per-NPC accumulation + isolation + persistence + onchain-tag + zero default');
  console.log('\nALL GCC-LEDGER SMOKE TESTS PASSED ✅');
}

main().catch((err) => {
  console.error('GCC-LEDGER SMOKE TEST FAILED ❌', err);
  process.exit(1);
});
