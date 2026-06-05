/**
 * Smoke test: AIGG platform NPCs in @onchainpal/gamekit.
 * Verifies that seedAiggPlatformNpcs() works in any SharedWorld — simulating
 * how a second MUD game would include the platform NPCs.
 *
 * Uses a fake ai.gg server; no real network calls.
 * Run: pnpm --filter @onchainpal/gamekit test:platform
 */
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { InMemoryStore, Metabolism, type InferenceProvider, type InferenceRequest, type InferenceResult } from '@onchainpal/npc-agent';
import { SharedWorld, seedAiggPlatformNpcs, AiggApiClient, menuRegistry, AIGG_NPC_IDS, AIGG_PLATFORM_NPC_IDS, AIGG_DEFAULT_ROOM, AIGG_DEFAULT_NAMES } from '../index';

// ── Fake ai.gg ───────────────────────────────────────────────────────────────
function startFakeAigg(): Promise<{ port: number; calls: string[]; close(): void }> {
  const calls: string[] = [];
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      calls.push(req.url ?? '/');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/api/v1/pricing/gcc') {
        res.end(JSON.stringify({ code: 0, message: 'success', data: {
          'claude-haiku-4-5':  { gcc_per_million_input: 25,  gcc_per_million_output: 125 },
          'claude-sonnet-4-6': { gcc_per_million_input: 75,  gcc_per_million_output: 375 },
          'gemini-2.0-flash':  { gcc_per_million_input: 2.5, gcc_per_million_output: 10  },
        }}));
      } else {
        res.end(JSON.stringify({ code: 1, message: 'not found', data: null }));
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ port, calls, close: () => server.close() });
    });
  });
}

class ScriptedProvider implements InferenceProvider {
  readonly id = 'scripted';
  async complete(_: InferenceRequest): Promise<InferenceResult> {
    return { text: JSON.stringify({ say: '好', effects: [], emotion: '平静' }),
      usage: { model: 'scripted', inputTokens: 5, outputTokens: 5, gccCost: 0.00005 } };
  }
}
const metabolism = new Metabolism({ tiers: [{ id: 'r', minBalanceGcc: 0.001, model: 'm', label: '充盈' }], starvingBelowGcc: 0.00001, defaultTierId: 'r' });

async function main() {
  const fake = await startFakeAigg();
  try {
    // Simulate "GameB" — a completely new MUD game that includes platform NPCs
    const gameB = new SharedWorld({
      store: new InMemoryStore(),
      provider: new ScriptedProvider(),
      metabolism,
      rooms: ['酒馆', '集市', '广场'],  // 集市 exists → 碧玄子 goes there
    });

    // ── The one-liner any game needs ─────────────────────────────────────
    const client = new AiggApiClient({ baseUrl: `http://127.0.0.1:${fake.port}` });
    await seedAiggPlatformNpcs(gameB, { apiClient: client });

    // ── 1. 碧玄子 in 集市 ─────────────────────────────────────────────────
    const npc = await gameB.getNpc(AIGG_NPC_IDS.PRICING);
    assert.ok(npc, '碧玄子 created in GameB');
    assert.equal(npc!.name, '碧玄子');
    assert.equal(npc!.room, AIGG_DEFAULT_ROOM, '碧玄子 placed in 集市 (default room)');
    assert.match(npc!.background, /claude-haiku-4-5/, 'pricing in background');
    console.log('  ✓ 碧玄子 seeded in GameB (集市)');

    // ── 2. menuRegistry populated ─────────────────────────────────────────
    assert.ok(menuRegistry.has(AIGG_NPC_IDS.PRICING), 'pricing menu registered');
    const menu = menuRegistry.get(AIGG_NPC_IDS.PRICING)!;
    assert.ok(menu.actions.length >= 3, 'menu has at least 3 actions');
    console.log(`  ✓ menu registered with ${menu.actions.length} actions`);

    // ── 3. api called exactly once (idempotent) ──────────────────────────
    assert.equal(fake.calls.filter(c => c === '/api/v1/pricing/gcc').length, 1, '1 API call');
    await seedAiggPlatformNpcs(gameB, { apiClient: client }); // second call
    assert.equal(fake.calls.filter(c => c === '/api/v1/pricing/gcc').length, 1, 'idempotent: still 1 call');
    console.log('  ✓ idempotent: second seedAiggPlatformNpcs() skips existing NPCs');

    // ── 4. custom room + custom name ─────────────────────────────────────
    const gameC = new SharedWorld({ store: new InMemoryStore(), provider: new ScriptedProvider(), metabolism, rooms: ['村口', '城内', '驿站'] });
    await seedAiggPlatformNpcs(gameC, { apiClient: client, room: '驿站', names: { PRICING: '账房先生' } });
    const npcC = await gameC.getNpc(AIGG_NPC_IDS.PRICING);
    assert.equal(npcC!.room, '驿站', 'custom room respected');
    assert.equal(npcC!.name, '账房先生', 'custom name respected');
    // menu title also uses custom name
    const menuC = menuRegistry.get(AIGG_NPC_IDS.PRICING)!;
    assert.match(menuC.title, /账房先生/, 'menu title uses custom name');
    console.log('  ✓ custom room (驿站) + custom name (账房先生) respected in NPC + menu title');

    // ── 5. npcsInRoom from any client ────────────────────────────────────
    const inRoom = await gameB.npcsInRoom('集市');
    assert.equal(inRoom.length, 1);
    assert.equal(inRoom[0].name, '碧玄子');
    console.log('  ✓ 碧玄子 visible in npcsInRoom(集市)');

    // ── 6. AIGG_PLATFORM_NPC_IDS + AIGG_DEFAULT_NAMES ────────────────────
    assert.ok(AIGG_PLATFORM_NPC_IDS.includes(AIGG_NPC_IDS.PRICING));
    assert.equal(AIGG_DEFAULT_NAMES.PRICING, '碧玄子', 'default name is 碧玄子');
    console.log(`  ✓ AIGG_PLATFORM_NPC_IDS has ${AIGG_PLATFORM_NPC_IDS.length} entry(ies); default name = ${AIGG_DEFAULT_NAMES.PRICING}`);

    // ── 7. menu cost calculator (pure arithmetic, no LLM) ────────────────
    const calcAction = menu.actions.find(a => a.label.includes('估算'))!;
    const calcStep = await calcAction.run();
    const result = await calcStep.handler!('claude-haiku-4-5 1m 200k');
    assert.ok(result.output.some(l => l.includes('50')), 'calc: haiku 1m+200k = 50 GCC');
    console.log('  ✓ menu calculator: haiku 1m/200k = 50 GCC (zero LLM)');

  } finally {
    fake.close();
  }
  console.log('\nAIGG-PLATFORM-NPCS SMOKE PASSED ✅');
}

main().catch(e => { console.error('FAILED ❌', e); process.exit(1); });
