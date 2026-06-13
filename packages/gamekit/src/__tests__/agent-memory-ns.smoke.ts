/**
 * agent-memory-ns smoke — multiverse spec §3: memory follows the SOUL.
 *
 *   1. unminted NPC → corpus stays world-local (`<ns>npcs/<id>/memory`);
 *   2. mint lands (`npc:<id>:tokenId` identity key appears in the store) →
 *      the VERY NEXT turn writes to `agent/<tokenId>/memory` — no restart,
 *      because negatives are never cached;
 *   3. tokenId is immutable → the positive is cached (a later key rewrite
 *      does not move the corpus).
 *
 * Run: npx tsx src/__tests__/agent-memory-ns.smoke.ts
 */
import assert from 'node:assert/strict';
import { SharedWorld } from '../shared-world';
import { InMemoryStore, AiggMemoryClient, Metabolism, type InferenceProvider, type InferenceResult, type Scope } from '@onchainpal/npc-agent';

class Scripted implements InferenceProvider {
  readonly id = 'scripted';
  async complete(): Promise<InferenceResult> {
    return { text: JSON.stringify({ say: '嗯。', effects: [] }), usage: { model: 's', inputTokens: 1, outputTokens: 1, gccCost: 0 } };
  }
}

/** fake aigg-memory capturing every corpus the world writes/reads. */
function fakeMemory(corpora: string[]): AiggMemoryClient {
  const client = new AiggMemoryClient({ baseUrl: 'http://fake' });
  (globalThis as any).fetch = (async (url: string, init?: { body?: string }) => {
    try {
      const body = init?.body ? JSON.parse(init.body) : {};
      const q = new URL(url).searchParams;
      const corpus = body.corpus ?? q.get('corpus');
      if (corpus) corpora.push(corpus);
    } catch { /* capture is best-effort */ }
    return { ok: true, status: 200, json: async () => ({ ok: true, diagnostics: [], data: { total: 0, units: [], bundle: '', written: [] } }) } as any;
  }) as unknown as typeof fetch;
  return client;
}

const W: Scope = { type: 'world' };

async function main() {
  const realFetch = globalThis.fetch;
  try {
    const corpora: string[] = [];
    const store = new InMemoryStore();
    const rich = new Metabolism({ tiers: [{ id: 'l', minBalanceGcc: 0, model: 'm', label: '清醒' }], starvingBelowGcc: -1, defaultTierId: 'l' });
    const world = new SharedWorld({
      store, provider: new Scripted(), metabolism: rich,
      memory: fakeMemory(corpora), memoryNamespace: 'pal', rooms: ['镇内']
    });
    const id = await world.createNpc({ name: '阿珠', owner: 'host:pal', background: '客栈侍女', room: '镇内', startGcc: 2 });

    // 1. unminted → world-local corpus
    corpora.length = 0;
    await world.talk({ npcId: id, visitorId: 'player:你', text: '你好' });
    assert.ok(corpora.length > 0, 'talk touched memory');
    assert.ok(corpora.every((c) => c.startsWith('pal/npcs/')), `unminted stays world-local, got: ${corpora[0]}`);
    console.log('  ✓ unminted: corpus = pal/npcs/<id>/memory (world-local)');

    // 2. mint lands → next turn switches to agent/<tokenId>/memory (no restart)
    await store.set(W, `npc:${id}:tokenId`, '42', { onchain: true });
    corpora.length = 0;
    await world.talk({ npcId: id, visitorId: 'player:你', text: '又见面了' });
    assert.ok(corpora.length > 0, 'talk touched memory');
    assert.ok(corpora.every((c) => c.startsWith('agent/42/')), `minted follows the soul, got: ${corpora[0]}`);
    console.log('  ✓ minted: corpus = agent/42/memory — switched on the very next turn');

    // 3. tokenId immutable → positive cached (a rogue rewrite does not move it)
    await store.set(W, `npc:${id}:tokenId`, '99', { onchain: true });
    corpora.length = 0;
    await world.talk({ npcId: id, visitorId: 'player:你', text: '三谈' });
    assert.ok(corpora.every((c) => c.startsWith('agent/42/')), 'cached tokenId wins (immutable identity)');
    console.log('  ✓ cache: tokenId is immutable — corpus pinned to agent/42');

    console.log('\nAGENT-MEMORY-NS SMOKE PASSED ✅');
  } finally {
    (globalThis as any).fetch = realFetch;
  }
}

main().catch((e) => { console.error('AGENT-MEMORY-NS SMOKE FAILED ❌', e); process.exit(1); });
