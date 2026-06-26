/**
 * Headless smoke for SharedWorldOptions.personaResolver — the persona seam.
 *
 * Proves: (1) a host-supplied resolver replaces the generic background persona
 * (custom addressing tiers reach resolveAddressing → TalkResult.addressing),
 * (2) the resolver receives the memory bundle, (3) returning undefined falls
 * back to the default persona, (4) no resolver = behaviour identical to before.
 * Run: pnpm --filter @aigg/gamekit test:persona
 */
import assert from 'node:assert/strict';
import { InMemoryStore, type InferenceProvider, type InferenceRequest, type InferenceResult, type NpcPersona } from '@aigg/npc-agent';
import { SharedWorld, type NpcRecord } from '../index';

class ScriptedProvider implements InferenceProvider {
  readonly id = 'scripted';
  lastPrompt = '';
  async complete(req: InferenceRequest): Promise<InferenceResult> {
    this.lastPrompt = req.prompt;
    return {
      text: JSON.stringify({ say: '幸会。', effects: [{ kind: 'adjustRelationship', delta: 5, reason: '攀谈' }] }),
      usage: { model: 'scripted', inputTokens: 10, outputTokens: 10, gccCost: 0.0001 }
    };
  }
}

async function main() {
  const provider = new ScriptedProvider();
  const resolved: Array<{ id: string; bundle?: string }> = [];

  const cardPersona = (rec: NpcRecord, memoryBundle?: string): NpcPersona | undefined => {
    resolved.push({ id: rec.id, bundle: memoryBundle });
    if (rec.id !== 'npc:azhu') return undefined; // host has no card → fall back
    return {
      id: rec.id, name: rec.name,
      role: `渔家少女阿珠。${memoryBundle ?? ''}`,
      tones: ['天真', '爽朗'],
      allowedEffects: ['adjustRelationship', 'setFlag'],
      caps: { relationshipDeltaPerTurn: 10 },
      addressing: [
        { minAffinity: 0, title: '客人' },
        { minAffinity: 30, title: '大哥哥' }
      ]
    } as NpcPersona;
  };

  const world = new SharedWorld({ store: new InMemoryStore(), provider, personaResolver: cardPersona });
  await world.createNpc({ id: 'npc:azhu', name: '阿珠', owner: 'host', background: '（卡片版人格生效时不应看到这句）', room: '广场', startGcc: 1 });
  await world.createNpc({ id: 'npc:stranger', name: '路人', owner: 'user:A', background: '一个匆匆赶路的旅人', room: '广场', startGcc: 1 });

  // (1) custom persona drives the talk: addressing comes from the card tiers
  const t1 = await world.talk({ npcId: 'npc:azhu', visitorId: 'player:李逍遥', text: '你好呀' });
  assert.equal(t1.addressing, '客人', 'card addressing tier used (not default 阁下)');
  assert.match(provider.lastPrompt, /渔家少女阿珠/, 'card role reached the LLM prompt');
  assert.ok(!provider.lastPrompt.includes('不应看到这句'), 'generic background persona replaced');
  assert.equal(resolved.length >= 1 && resolved[0].id, 'npc:azhu', 'resolver called with the record');

  // (3) resolver returns undefined → default background persona
  const t2 = await world.talk({ npcId: 'npc:stranger', visitorId: 'player:李逍遥', text: '请问去余杭怎么走' });
  assert.equal(t2.addressing, '阁下', 'fallback to default addressing tiers');
  assert.match(provider.lastPrompt, /匆匆赶路的旅人/, 'fallback uses the background');

  // (4) no resolver configured → identical to before
  const plain = new SharedWorld({ store: new InMemoryStore(), provider });
  await plain.createNpc({ id: 'npc:azhu', name: '阿珠', owner: 'host', background: '渔家少女', room: '广场', startGcc: 1 });
  const t3 = await plain.talk({ npcId: 'npc:azhu', visitorId: 'player:李逍遥', text: '你好' });
  assert.equal(t3.addressing, '阁下', 'no resolver → default persona unchanged');

  console.log('✓ personaResolver replaces persona (addressing+role) / falls back on undefined / absent = legacy behaviour');
  console.log('\nPERSONA-RESOLVER SMOKE PASSED ✅');
}

main().catch((err) => { console.error('PERSONA-RESOLVER SMOKE FAILED ❌', err); process.exit(1); });
