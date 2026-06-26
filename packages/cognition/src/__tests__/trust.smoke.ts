/** Smoke for TrustLedger. Run: pnpm --filter @aigg/cognition test:trust */
import assert from 'node:assert/strict';
import { TrustLedger, TRUST_DELTAS } from '../social/trust';
import { InMemoryKV } from '../kernel/kv';

async function main() {
  const t = new TrustLedger(new InMemoryKV());
  assert.equal(await t.get('a', 'v'), 0, 'unseen pair → 0');

  await t.update('a', 'v', TRUST_DELTAS.scammed);
  assert.ok(Math.abs((await t.get('a', 'v')) - (-0.3)) < 1e-9, 'scammed → -0.3');

  // accumulates and clamps at -1
  for (let i = 0; i < 5; i++) await t.update('a', 'v', TRUST_DELTAS.scammed);
  assert.equal(await t.get('a', 'v'), -1, 'clamps at -1');

  // per-pair isolation
  assert.equal(await t.get('a', 'other'), 0, 'other peer unaffected');
  assert.equal(await t.get('b', 'v'), 0, 'other self unaffected');

  // clamps at +1
  const t2 = new TrustLedger(new InMemoryKV());
  for (let i = 0; i < 30; i++) await t2.update('a', 'v', TRUST_DELTAS.kept);
  assert.equal(await t2.get('a', 'v'), 1, 'clamps at +1');

  // persists across ledger instances over the same KV
  const kv = new InMemoryKV();
  await new TrustLedger(kv).update('a', 'v', -0.2);
  assert.ok(Math.abs((await new TrustLedger(kv).get('a', 'v')) - (-0.2)) < 1e-9, 'persists via shared KV');

  console.log('ALL TRUST SMOKE TESTS PASSED ✅');
}
main().catch((e) => { console.error('TRUST SMOKE FAILED ❌', e); process.exit(1); });
