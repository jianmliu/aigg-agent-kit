/**
 * Step-1 smoke — the deterministic world STF + AI-oracle boundary.
 *
 * Proves the world is a reproducible state-transition function (so it can run as
 * a sequencer / Autonomys Domain with fraud proofs): same state + same txs →
 * identical state + reproducible state root; effects apply deterministically;
 * and the non-deterministic LLM is quarantined behind an InferenceOracle whose
 * (attestable) output becomes a deterministic applyTalk tx.
 *
 * Run: tsx src/__tests__/world-stf.smoke.ts
 */
import assert from 'node:assert/strict';
import { DefaultGameRules } from '@aigg/npc-agent';
import type { Effect, NpcPersona, InferenceProvider, InferenceRequest, InferenceResult } from '@aigg/npc-agent';
import { applyTx, applyAll, stateRoot, emptyWorld, relKey, type WorldTx, type WorldState } from '../stf/world-stf';
import { LlmInferenceOracle, type OracleInput } from '../stf/inference-oracle';

// persona for 酒剑仙: allows adjustRelationship + setFlag, caps delta at 15.
const persona = (id: string): NpcPersona => ({
  id, name: '酒剑仙', role: '嗜酒的剑客',
  allowedEffects: ['adjustRelationship', 'setFlag'],
  caps: { relationshipDeltaPerTurn: 15 },
  addressing: [{ minAffinity: 0, title: '阁下' }, { minAffinity: 30, title: '朋友' }],
} as NpcPersona);
const rules = new DefaultGameRules(persona);

const NPC = 'npc:酒剑仙';
const SEED: WorldTx[] = [
  { type: 'createNpc', id: NPC, name: '酒剑仙', owner: 'player:A', room: '酒馆', background: '嗜酒高人', draft: true },
  { type: 'activate', npcId: NPC, amountGcc: 0.01 },
];

async function main() {
  // ── 1. determinism / replay / reproducible state root ───────────────────────
  const talk: WorldTx = { type: 'applyTalk', npcId: NPC, playerId: 'player:V', effects: [{ kind: 'adjustRelationship', delta: 5, reason: '论剑' }], gccCost: 0.0003, now: 1000 };
  const seq = [...SEED, talk, { type: 'donate', npcId: NPC, amountGcc: 0.02 } as WorldTx, { type: 'move', npcId: NPC, room: '广场' } as WorldTx];

  const a = applyAll(emptyWorld(), seq, rules);
  const b = applyAll(emptyWorld(), seq, rules);
  assert.deepEqual(a.state, b.state, 'same txs → identical state (deterministic)');
  assert.equal(stateRoot(a.state), stateRoot(b.state), 'state root reproducible');
  assert.notEqual(stateRoot(emptyWorld() as WorldState), stateRoot(a.state), 'root changes with state');
  console.log(`  ✓ deterministic replay + reproducible state root (${stateRoot(a.state).slice(0, 12)}…)`);

  // ── 2. purity: applyTx never reads a clock/RNG — same input, same output N× ──
  const s0 = applyAll(emptyWorld(), SEED, rules).state;
  const r1 = applyTx(s0, talk, rules);
  const r2 = applyTx(s0, talk, rules);
  assert.deepEqual(r1.state, r2.state, 'applyTx is pure (no Date.now/RNG inside)');
  assert.deepEqual(applyTx(s0, talk, rules).state, r1.state, 'input untouched / repeatable');
  assert.deepEqual(s0, applyAll(emptyWorld(), SEED, rules).state, 'prev state not mutated by applyTx');
  console.log('  ✓ applyTx pure: identical output, input immutable');

  // ── 3. lifecycle: createNpc(draft) → activate → donate → move ───────────────
  const lc = applyAll(emptyWorld(), SEED, rules).state;
  assert.equal(lc.npcs[NPC].status, 'active', 'activate flips draft → active');
  assert.ok(lc.registry.includes(NPC), 'activate adds to registry (globally visible)');
  assert.equal(lc.balances[NPC], 0.01, 'activate sets balance');
  const afterDonate = applyTx(lc, { type: 'donate', npcId: NPC, amountGcc: 0.02 }, rules).state;
  assert.equal(afterDonate.balances[NPC], 0.03, 'donate adds to balance');
  const afterMove = applyTx(lc, { type: 'move', npcId: NPC, room: '广场' }, rules).state;
  assert.equal(afterMove.npcs[NPC].room, '广场', 'move updates room');
  console.log('  ✓ lifecycle: draft→activate(registry+balance)→donate→move');

  // ── 4. applyTalk: effect applied + burn + anti-cheat rejection ───────────────
  const t = applyTx(lc, talk, rules);
  assert.equal(t.state.relationships[relKey(NPC, 'player:V')].affinity, 5, 'adjustRelationship applied to affinity');
  assert.equal(t.state.relationships[relKey(NPC, 'player:V')].lastInteractionAt, 1000, 'now carried in tx (not clock)');
  assert.equal(t.state.balances[NPC], 0.01 - 0.0003, 'gccCost burned (耗)');
  // over-cap delta (16 > cap 15) → rejected by DefaultGameRules, not applied
  const cheat = applyTx(lc, { type: 'applyTalk', npcId: NPC, playerId: 'player:V', effects: [{ kind: 'adjustRelationship', delta: 16, reason: 'x' }], gccCost: 0, now: 2000 }, rules);
  assert.ok(cheat.events.some((e) => e.kind === 'rejected'), 'over-cap effect rejected');
  assert.equal(cheat.state.relationships[relKey(NPC, 'player:V')], undefined, 'rejected effect not applied');
  console.log('  ✓ applyTalk: affinity+burn applied; over-cap effect rejected (anti-cheat reused)');

  // ── 5. oracle → tx → STF: AI quarantined, output is a deterministic tx ───────
  class ScriptedAttestedProvider implements InferenceProvider {
    readonly id = 'scripted-attested';
    async complete(_r: InferenceRequest): Promise<InferenceResult> {
      return {
        text: JSON.stringify({ say: '幸会！', effects: [{ kind: 'adjustRelationship', delta: 4, reason: '攀谈' }], emotion: '热情' }),
        usage: { model: 'm', inputTokens: 10, outputTokens: 8, gccCost: 0.0002 },
        attestation: { model: 'm', promptHash: '0xpp', responseHash: '0xrr', signature: '0xsig', signedAt: 1 },
      };
    }
  }
  const oracle = new LlmInferenceOracle({ provider: new ScriptedAttestedProvider() });
  const input: OracleInput = { npcId: NPC, playerId: 'player:W', text: '前辈请教', persona: persona(NPC), balanceGcc: 0.01, rel: { affinity: 0, tags: [] } };
  const out = await oracle.produce(input);
  assert.equal(out.say, '幸会！', 'oracle returns the say');
  assert.equal((out.effects[0] as Extract<Effect, { kind: 'adjustRelationship' }>).delta, 4, 'oracle returns effects');
  assert.equal(out.gccCost, 0.0002, 'oracle surfaces gcc cost');
  assert.ok(out.attestation?.signature, 'oracle surfaces the provider attestation (committable provenance)');
  // the oracle output becomes a deterministic applyTalk tx → STF
  const committed = applyTx(lc, { type: 'applyTalk', npcId: NPC, playerId: 'player:W', effects: out.effects, gccCost: out.gccCost, now: 3000 }, rules);
  assert.equal(committed.state.relationships[relKey(NPC, 'player:W')].affinity, 4, 'oracle effects committed deterministically via STF');
  console.log('  ✓ oracle (LLM, attested) → applyTalk tx → STF: AI quarantined, committed deterministically');

  console.log('\nWORLD-STF (step 1: sequencer/domain-ready core) SMOKE PASSED ✅');
}

main().catch((err) => { console.error('WORLD-STF SMOKE FAILED ❌', err); process.exit(1); });
