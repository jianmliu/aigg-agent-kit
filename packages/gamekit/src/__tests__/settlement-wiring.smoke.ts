/**
 * PR-B ④ smoke (nanopayment wiring) — SharedWorld.talk() drives the
 * SettlementStrategy seam: the "耗(thinking burn)" rail.
 *
 * Proves talk() calls settle(npcId, usage) once per paid turn and surfaces the
 * result, so injecting X402GccEip3009Settlement makes each turn a facilitator
 * nanopayment. We use a FAKE SettlementStrategy here to test the WIRING; the
 * real X402 → facilitator /verify (EIP-3009 sign, payer recovery) is covered by
 * onchain/x402-facilitator.smoke.ts. Composition = the full path.
 *
 * Run: tsx src/__tests__/settlement-wiring.smoke.ts
 */
import assert from 'node:assert/strict';
import { InMemoryStore, Metabolism, type InferenceProvider, type InferenceRequest, type InferenceResult, type SettlementStrategy, type SettlementResult, type InferenceUsage } from '@onchainpal/npc-agent';
import { SharedWorld } from '../shared-world';

class PaidProvider implements InferenceProvider {
  readonly id = 'paid';
  async complete(_req: InferenceRequest): Promise<InferenceResult> {
    return {
      text: JSON.stringify({ say: '请讲。', effects: [{ kind: 'adjustRelationship', delta: 3, reason: '交谈' }], emotion: '平和' }),
      usage: { model: 'paid', inputTokens: 500, outputTokens: 60, gccCost: 0.0003 },
    };
  }
}

/** records each settle() call — stands in for X402GccEip3009Settlement. */
class FakeSettlement implements SettlementStrategy {
  readonly calls: Array<{ npcId: string; usage: InferenceUsage }> = [];
  constructor(private readonly mode: 'x402' | 'reject' = 'x402') {}
  async settle(npcId: string, usage: InferenceUsage): Promise<SettlementResult> {
    this.calls.push({ npcId, usage });
    if (this.mode === 'reject') throw new Error('facilitator verify rejected');
    return { gccCost: usage.gccCost ?? 0, mode: 'x402', receiptId: `verify:0xNPC` };
  }
}

const metabolism = new Metabolism({ tiers: [{ id: 'r', minBalanceGcc: 0.0005, model: 'm', label: '充盈' }, { id: 'l', minBalanceGcc: 0.0001, model: 'm', label: '清醒' }], starvingBelowGcc: 0.0001, defaultTierId: 'l' });

async function main() {
  // ── 1. settlement injected → talk() settles each paid turn ──────────────────
  const settle = new FakeSettlement();
  const world = new SharedWorld({ store: new InMemoryStore(), provider: new PaidProvider(), metabolism, settlement: settle });
  const id = await world.createNpc({ name: '玄机子', owner: 'player:A', background: '通晓阴阳', room: '广场', startGcc: 1 }); // funded → can think

  const r1 = await world.talk({ npcId: id, visitorId: 'player:V', text: '请教一卦' });
  assert.equal(settle.calls.length, 1, 'one settle per paid turn');
  assert.equal(settle.calls[0].npcId, id, 'settle called with the NPC id');
  assert.equal(settle.calls[0].usage.gccCost, 0.0003, 'settle receives the turn usage (gccCost)');
  assert.equal(r1.settlement?.mode, 'x402', 'TalkResult surfaces the nanopayment mode');
  assert.equal(r1.settlement?.ok, true, 'nanopayment ok');
  assert.equal(r1.settlement?.receiptId, 'verify:0xNPC', 'receipt surfaced');
  console.log(`  ✓ talk() → settle(npcId, usage) per paid turn; receipt=${r1.settlement?.receiptId}`);

  // ── 2. multiple turns → one nanopayment each ────────────────────────────────
  await world.talk({ npcId: id, visitorId: 'player:V', text: '再问' });
  await world.talk({ npcId: id, visitorId: 'player:W', text: '你好' });
  assert.equal(settle.calls.length, 3, 'three paid turns → three nanopayments');
  console.log('  ✓ 3 turns → 3 nanopayments (one verify per turn)');

  // ── 3. rejected nanopayment is non-fatal (reply still delivered) ────────────
  const rejWorld = new SharedWorld({ store: new InMemoryStore(), provider: new PaidProvider(), metabolism, settlement: new FakeSettlement('reject') });
  const id2 = await rejWorld.createNpc({ name: '断尘', owner: 'player:A', background: '剑客', room: '广场', startGcc: 1 });
  const r2 = await rejWorld.talk({ npcId: id2, visitorId: 'player:V', text: '论剑' });
  assert.ok(r2.said, 'reply still delivered despite rejected nanopayment');
  assert.equal(r2.settlement?.ok, false, 'rejected nanopayment surfaced as ok:false');
  assert.equal(r2.settlement?.mode, 'failed', 'failed mode surfaced');
  console.log('  ✓ rejected nanopayment is non-fatal — reply delivered, ok:false surfaced');

  // ── 4. no settlement injected → backward compatible (no settlement field) ───
  const plain = new SharedWorld({ store: new InMemoryStore(), provider: new PaidProvider(), metabolism });
  const id3 = await plain.createNpc({ name: '无相', owner: 'player:A', background: '隐者', room: '广场', startGcc: 1 });
  const r3 = await plain.talk({ npcId: id3, visitorId: 'player:V', text: '问道' });
  assert.equal(r3.settlement, undefined, 'no settlement strategy → no settlement field (unchanged behavior)');
  assert.ok(r3.said, 'plain talk still works');
  console.log('  ✓ no settlement injected → backward compatible');

  // ── 5. starving NPC (no GCC) → no inference, no nanopayment ──────────────────
  const starveSettle = new FakeSettlement();
  const starveWorld = new SharedWorld({ store: new InMemoryStore(), provider: new PaidProvider(), metabolism, settlement: starveSettle });
  const id4 = await starveWorld.createNpc({ name: '枯井', owner: 'player:A', background: '空', room: '广场', startGcc: 0 }); // no fuel
  const r4 = await starveWorld.talk({ npcId: id4, visitorId: 'player:V', text: '在吗' });
  assert.equal(starveSettle.calls.length, 0, 'starving NPC: no thinking → no nanopayment');
  assert.ok(r4.starving, 'NPC reported starving');
  console.log('  ✓ starving NPC → no nanopayment (no thinking to pay for)');

  console.log('\nSETTLEMENT-WIRING (PR-B ④ nanopayment) SMOKE PASSED ✅');
}

main().catch((err) => { console.error('SETTLEMENT-WIRING SMOKE FAILED ❌', err); process.exit(1); });
