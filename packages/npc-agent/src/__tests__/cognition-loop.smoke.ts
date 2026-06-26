/**
 * Headless smoke test for the P0 ③a cognition loop — no PAL, no live Ollama.
 * Uses a FakeProvider returning canned model output so the test is deterministic.
 * Run: pnpm --filter @aigg/npc-agent test:smoke
 *
 * Asserts the full vertical: perception → LlmAgent (parse structured intent) →
 * EffectResolver (GameRules validation) → relationship memory update + addressing
 * change → actuator.say. Also checks GameRules drops an over-cap effect.
 */
import assert from 'node:assert/strict';

import type { InferenceProvider, InferenceRequest, InferenceResult } from '../inference/provider';
import type { Actuator, Perception, StateDelta } from '../index';
import {
  LlmAgent,
  AgentRuntime,
  EffectResolver,
  DefaultGameRules,
  InMemoryStore,
  RelationshipMemory,
  resolveAddressing
} from '../index';
import type { NpcPersona } from '../persona/persona';

// --- fixtures ----------------------------------------------------------------

const jianxian: NpcPersona = {
  id: 'npc:jiu-jianxian',
  name: '酒剑仙',
  role: '嗜酒如命的剑道高人',
  tones: ['豪迈', '醉态'],
  allowedEffects: ['adjustRelationship', 'setFlag'],
  caps: { relationshipDeltaPerTurn: 20 },
  addressing: [
    { minAffinity: 0, title: '小友' },
    { minAffinity: 30, title: '老朋友' }
  ]
};

class FakeProvider implements InferenceProvider {
  readonly id = 'fake';
  constructor(private readonly reply: string) {}
  async complete(_req: InferenceRequest): Promise<InferenceResult> {
    return {
      text: this.reply,
      usage: { model: 'fake', inputTokens: 100, outputTokens: 20, gccCost: 0.00014 }
    };
  }
}

class RecordingActuator implements Actuator {
  said: Array<{ npcId: string; line: string }> = [];
  appliedDeltas: StateDelta[] = [];
  async say(npcId: string, line: string): Promise<void> {
    this.said.push({ npcId, line });
  }
  async apply(delta: StateDelta): Promise<void> {
    this.appliedDeltas.push(delta);
  }
}

function interaction(text: string): Perception {
  return { kind: 'interaction', npcId: jianxian.id, playerId: 'player:hero', text, timestamp: 1 };
}

function buildRuntime(reply: string, usageSink?: any[]) {
  const store = new InMemoryStore();
  const relationships = new RelationshipMemory(store);
  const provider = new FakeProvider(reply);
  const agent = new LlmAgent({
    persona: jianxian,
    provider,
    relationships,
    onUsage: usageSink ? (u) => usageSink.push(u) : undefined
  });
  const resolver = new EffectResolver(new DefaultGameRules((id) => (id === jianxian.id ? jianxian : undefined)));
  const actuator = new RecordingActuator();
  const runtime = new AgentRuntime({ agent, resolver, relationships, actuator, now: () => 12345 });
  return { runtime, store, relationships, actuator, provider };
}

// --- tests -------------------------------------------------------------------

async function test1_happyPath() {
  const usage: any[] = [];
  const { runtime, relationships, actuator } = buildRuntime(
    '```json\n{"say":"哈哈，好酒！与你投缘。","effects":[{"kind":"adjustRelationship","delta":10,"reason":"玩家请喝酒"}],"emotion":"高兴"}\n```',
    usage
  );

  const res = await runtime.handle(interaction('老伯，请你喝酒'));

  assert.equal(res.said, '哈哈，好酒！与你投缘。', 'NPC should speak the parsed line');
  assert.equal(actuator.said.length, 1, 'say() called once');
  assert.equal(res.delta?.effects.length, 1, 'one effect survived');
  assert.equal(res.delta?.rejected.length, 0, 'nothing rejected');

  const rel = await relationships.get(jianxian.id, 'player:hero');
  assert.equal(rel.affinity, 10, 'affinity increased by 10');
  assert.equal(rel.lastInteractionAt, 12345, 'timestamp stamped from injected clock');
  assert.equal(usage.length, 1, 'usage metered once');
  assert.ok(usage[0].gccCost > 0, 'gccCost computed (metering works)');
  console.log('✓ test1 happy path: structured intent → relationship++ → say + metered');
}

async function test2_addressingChanges() {
  const { runtime, relationships } = buildRuntime(
    '{"say":"再来！","effects":[{"kind":"adjustRelationship","delta":20,"reason":"再次共饮"}]}'
  );
  // two interactions push affinity 20 → 40, crossing the 30 threshold
  await runtime.handle(interaction('再请一杯'));
  await runtime.handle(interaction('再来一杯'));
  const rel = await relationships.get(jianxian.id, 'player:hero');
  assert.equal(rel.affinity, 40, 'affinity accumulates across turns (persisted memory)');
  assert.equal(resolveAddressing(jianxian, rel.affinity), '老朋友', 'addressing upgrades past threshold');
  console.log('✓ test2 memory persists across turns → addressing 小友→老朋友');
}

async function test3_gameRulesRejectOverCap() {
  const { runtime } = buildRuntime(
    '{"say":"哈！","effects":[{"kind":"adjustRelationship","delta":999,"reason":"刷分"},{"kind":"setFlag","flag":"met_jianxian","value":1}]}'
  );
  const res = await runtime.handle(interaction('给我加好感'));
  const kinds = res.delta?.effects.map((e) => e.kind) ?? [];
  assert.ok(!kinds.includes('adjustRelationship') || res.delta?.rejected.some((r) => r.effect.kind === 'adjustRelationship'),
    'over-cap relationship delta rejected by GameRules');
  assert.ok(res.delta?.rejected.some((r) => r.reason.includes('cap')), 'rejection reason mentions cap');
  assert.ok(kinds.includes('setFlag'), 'valid setFlag still passes');
  console.log('✓ test3 GameRules: over-cap effect rejected, valid effect kept');
}

async function test4_malformedOutput() {
  const { runtime, actuator } = buildRuntime('the model rambled with no json at all');
  const res = await runtime.handle(interaction('喂'));
  assert.equal(res.said, null, 'no line spoken on unparseable output');
  assert.equal(actuator.said.length, 0, 'say not called');
  console.log('✓ test4 malformed model output → graceful no-op (no crash)');
}

async function main() {
  await test1_happyPath();
  await test2_addressingChanges();
  await test3_gameRulesRejectOverCap();
  await test4_malformedOutput();
  console.log('\nALL COGNITION-LOOP SMOKE TESTS PASSED ✅');
}

main().catch((err) => {
  console.error('SMOKE TEST FAILED ❌', err);
  process.exit(1);
});
