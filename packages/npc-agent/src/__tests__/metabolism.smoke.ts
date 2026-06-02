/**
 * Headless smoke for cognitive metabolism (I-phase): GCC balance → model tier /
 * can-think, and the LlmAgent wiring (starving NPC emits a scripted line and
 * never calls the LLM → no GCC burn).
 * Run: pnpm --filter @onchainpal/npc-agent test:metabolism
 */
import assert from 'node:assert/strict';
import {
  Metabolism, DEFAULT_METABOLISM, hungerIntent,
  LlmAgent, RelationshipMemory, InMemoryStore,
  type InferenceProvider, type InferenceResult
} from '../index';

function intentJson(say: string): string {
  return JSON.stringify({ say, effects: [], emotion: 'neutral' });
}

/** fake provider that counts calls, so we can prove "no LLM call when starving". */
class CountingProvider implements InferenceProvider {
  readonly id: string;
  calls = 0;
  constructor(id: string) { this.id = id; }
  async complete(): Promise<InferenceResult> {
    this.calls++;
    return { text: intentJson(`[${this.id}] 你好`), usage: { model: this.id, inputTokens: 10, outputTokens: 5, gccCost: 0.0001 } };
  }
}

async function main() {
  // --- decision matrix ---
  const m = DEFAULT_METABOLISM;
  assert.equal(m.decide(null).tier.id, 'sonnet', 'unknown balance → default tier (act normally)');
  assert.equal(m.decide(null).canThink, true);
  assert.equal(m.decide(5).tier.id, 'opus', 'rich → opus');
  assert.equal(m.decide(0.5).tier.id, 'sonnet', 'mid → sonnet');
  assert.equal(m.decide(0.01).tier.id, 'haiku', 'low → haiku');
  assert.equal(m.decide(0.01).canThink, true, 'low but above starving → can think');
  const starving = m.decide(0.0001);
  assert.equal(starving.canThink, false, 'below starving threshold → cannot think');
  assert.equal(starving.starving, true);

  // boundary: exactly at a tier threshold qualifies
  assert.equal(m.decide(1).tier.id, 'opus', 'exactly minBalance qualifies');
  assert.equal(m.decide(0.005).canThink, true, 'exactly at starving threshold can still think (strict <)');

  // hungerIntent shape
  const hi = hungerIntent('（打盹）唔…？');
  assert.equal(hi.say, '（打盹）唔…？');
  assert.deepEqual(hi.effects, []);

  // custom config: tiers sort + default fallback
  const m2 = new Metabolism({ tiers: [{ id: 'lo', minBalanceGcc: 0, model: 'a' }, { id: 'hi', minBalanceGcc: 10, model: 'b' }], starvingBelowGcc: 0 });
  assert.equal(m2.decide(50).tier.id, 'hi');
  assert.equal(m2.decide(0).tier.id, 'lo');

  // --- LlmAgent integration ---
  const relationships = new RelationshipMemory(new InMemoryStore());
  const persona: any = {
    id: 'npc:jiu-jianxian', name: '酒剑仙', role: '剑仙',
    addressing: [{ minAffinity: 0, title: '小友' }]
  };
  const provider = new CountingProvider('claude-opus-4-8');
  const cheap = new CountingProvider('claude-haiku');

  // (a) starving NPC: scripted line, provider NOT called
  let balance = 0.0001;
  let lastTier = '';
  const starveAgent = new LlmAgent({
    persona, provider, relationships, metabolism: m,
    readBalanceGcc: async () => balance,
    hungerLine: '（醉倒）……改日再说……',
    onMetabolism: (d) => { lastTier = d.tier.id; }
  });
  const out1 = await starveAgent.perceive({ kind: 'interaction', npcId: persona.id, playerId: 'p1', text: '老伯' } as any);
  assert.equal(provider.calls, 0, 'starving → provider NOT called (no GCC burn)');
  assert.equal(out1?.say, '（醉倒）……改日再说……', 'starving → scripted hunger line');

  // (b) healthy NPC: provider IS called
  balance = 5;
  const out2 = await starveAgent.perceive({ kind: 'interaction', npcId: persona.id, playerId: 'p1', text: '老伯' } as any);
  assert.equal(provider.calls, 1, 'healthy → provider called once');
  assert.equal(lastTier, 'opus', 'rich balance routed to opus tier');
  assert.ok(out2?.say?.includes('claude-opus-4-8'), 'healthy → real (fake) LLM reply');

  // (c) resolveProvider routes by tier (model tiering)
  balance = 0.01; // haiku tier
  const routed = new LlmAgent({
    persona, provider, relationships, metabolism: m,
    readBalanceGcc: async () => balance,
    resolveProvider: (d) => (d.tier.id === 'haiku' ? cheap : provider)
  });
  await routed.perceive({ kind: 'interaction', npcId: persona.id, playerId: 'p2', text: 'hi' } as any);
  assert.equal(cheap.calls, 1, 'low tier routed to the cheap provider');
  assert.equal(provider.calls, 1, 'expensive provider not used for low tier (still 1 from earlier)');

  console.log('✓ tier matrix + starving gate (no LLM call) + hunger line + model routing');
  console.log('\nALL METABOLISM SMOKE TESTS PASSED ✅');
}

main().catch((err) => { console.error('METABOLISM SMOKE TEST FAILED ❌', err); process.exit(1); });
