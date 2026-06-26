/**
 * Headless smoke for SharedWorld — the core toolkit loop, with TWO SharedWorld
 * instances over ONE shared store (= two clients of the same world; swap the
 * store for MudStore and they'd be two clients of the same on-chain MUD World).
 *
 * Proves: user A creates + funds + places an AI NPC → user B (a different client)
 * discovers it, talks to it (it thinks on A's GCC, burns it, remembers B) → B
 * donates → balance rises. Run: pnpm --filter @aigg/gamekit test:world
 */
import assert from 'node:assert/strict';
import { InMemoryStore, Metabolism, type InferenceProvider, type InferenceRequest, type InferenceResult } from '@aigg/npc-agent';
import { SharedWorld } from '../index';

// scripted NPC (zero-dep). gccCost meaningful so the balance story plays out.
class ScriptedProvider implements InferenceProvider {
  readonly id = 'scripted';
  private i = 0;
  private lines = [
    { say: '客官好眼力！这坛女儿红埋了二十年。', aff: 5 },
    { say: '看你面善，便宜你一壶，交个朋友。', aff: 6 }
  ];
  async complete(req: InferenceRequest): Promise<InferenceResult> {
    const l = this.lines[this.i++ % this.lines.length];
    return {
      text: JSON.stringify({ say: l.say, effects: [{ kind: 'adjustRelationship', delta: l.aff, reason: '攀谈' }], emotion: '热情' }),
      usage: { model: 'scripted', inputTokens: 50, outputTokens: 40, gccCost: 0.0003 }
    };
  }
}

// demo-scaled metabolism (small thresholds so funding/starving is visible)
const metabolism = new Metabolism({
  tiers: [{ id: 'rich', minBalanceGcc: 0.0005, model: 'm', label: '充盈' }, { id: 'low', minBalanceGcc: 0.0001, model: 'm', label: '清醒' }],
  starvingBelowGcc: 0.0001, defaultTierId: 'low'
});

async function main() {
  const store = new InMemoryStore(); // shared backing → both clients see the same world
  const provider = new ScriptedProvider();
  const A = new SharedWorld({ store, provider, metabolism });   // user A's client
  const B = new SharedWorld({ store, provider, metabolism });   // user B's client (same world)

  // A creates its NPC (free-text background), funds it, places it in 广场
  const id = await A.createNpc({ name: '王二', owner: 'user:A', background: '城南卖酒的老板，豪爽好客，爱讲江湖旧事', room: '广场', startGcc: 0.0009 });
  assert.equal(await A.balanceGcc(id), 0.0009);

  // B (a different client) discovers it in the public room
  const inPlaza = await B.npcsInRoom('广场');
  assert.equal(inPlaza.length, 1, 'B sees the NPC A placed (shared world)');
  assert.equal(inPlaza[0].name, '王二');
  assert.equal(inPlaza[0].owner, 'user:A');

  // B talks → NPC thinks on A's GCC, burns it, remembers B
  const t1 = await B.talk({ npcId: id, visitorId: 'user:B', text: '老板，来壶你最好的酒！' });
  assert.ok(t1.said && t1.said.length > 0, 'NPC replied');
  assert.equal(t1.dAffinity, 5, 'relationship formed with visitor B');
  assert.ok(Math.abs(t1.costGcc - 0.0003) < 1e-9, 'thinking burned GCC');
  assert.ok(Math.abs(t1.balanceGcc - 0.0006) < 1e-9, 'balance dropped (0.0009 - 0.0003)');
  // the burn is visible from A's client too (shared state)
  assert.ok(Math.abs((await A.balanceGcc(id)) - 0.0006) < 1e-9, 'A sees the burn (shared world)');

  // talk again → burns more, relationship grows, tier may drop
  const t2 = await B.talk({ npcId: id, visitorId: 'user:B', text: '你这酒真不错!' });
  assert.equal(t2.affinity, 11, 'affinity accumulates (5+6)');
  assert.ok(Math.abs(t2.balanceGcc - 0.0003) < 1e-9, 'balance now 0.0003');

  // burn it dry → starving (no LLM, no burn)
  const t3 = await B.talk({ npcId: id, visitorId: 'user:B', text: '再来一壶' }); // 0.0003 → 0
  const t4 = await B.talk({ npcId: id, visitorId: 'user:B', text: '老板?' });    // balance 0 → starving
  assert.equal(t4.starving, true, 'NPC starves when GCC runs out');
  assert.equal(t4.costGcc, 0, 'starving NPC burns no GCC (no LLM call)');
  assert.match(t4.said ?? '', /灵力枯竭/, 'hunger line');

  // a PATRON (user C, not the owner) donates → NPC revives
  const bal = await B.donate('user:C', id, 0.001);
  assert.ok(Math.abs(bal - 0.001) < 1e-9, 'patron donation tops up the NPC');
  const t5 = await B.talk({ npcId: id, visitorId: 'user:B', text: '又有酒喝了?' });
  assert.equal(t5.starving, false, 'revived after donation');
  assert.ok(t5.said!.length > 0 && t5.costGcc > 0, 'thinks again');

  console.log('✓ A creates+funds+places NPC → B discovers+talks (NPC thinks on A’s GCC, remembers B) → starves → patron donates → revives');
  console.log('\nSHARED-WORLD SMOKE PASSED ✅');
}

main().catch((err) => { console.error('SHARED-WORLD SMOKE FAILED ❌', err); process.exit(1); });
