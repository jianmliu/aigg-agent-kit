/**
 * Smoke: SharedWorld.forgeArtifact — 铸造奇物闭环 (Task M2 T3)
 *
 * Verifies:
 *   - successful forge debits silver (100 → 60) and returns the artifact id
 *   - artifact is persisted + owned (artifactsOf durable read)
 *   - can't-afford path rejects without touching silver balance
 *
 * Run: pnpm --filter @onchainpal/gamekit test:forge
 */
import assert from 'node:assert/strict';
import { InMemoryStore } from '@onchainpal/npc-agent';
import { SharedWorld } from '../shared-world';

async function main() {
  const store = new InMemoryStore();
  // SharedWorldOptions requires `provider` — supply a minimal no-op stub.
  // The smoke never calls talk(), so inference is never invoked.
  const provider = {
    id: 'stub',
    complete: async () => ({ text: '{}', usage: { model: 'stub', inputTokens: 0, outputTokens: 0, gccCost: 0 } }),
  };

  const world = new SharedWorld({ store, provider });

  // startSilver: 0 overrides the default 10-silver seed so grantSilver puts us at exactly 100
  await world.createNpc({ id: 'npc:u', name: 'Urist', owner: 'sys', room: 'r:forge', background: 'miner', startSilver: 0 });
  // seed Urist's silver via grantSilver (mirrors hunt.smoke.ts pattern)
  await (world as any).grantSilver('npc:u', 100);

  const prov = { creatorNpcId: 'npc:u', deedSeq: 12, worldId: 'dwarf', season: 1, createdAt: 1000, tba: '0xabc' };

  // 1. forges: debits silver, returns id
  const r = await world.forgeArtifact({
    npcId: 'npc:u', kind: 'statue', name: '岩心之泪', engraving: '铭 Urist 斩哥布林',
    provenance: prov, costSilver: 40, now: 1000,
  });
  assert.ok(r.ok, `forged: ${r.reason ?? ''}`);
  assert.equal(r.balanceSilver, 60, 'silver debited 100→60');
  assert.match(r.artifactId!, /^art:[0-9a-f]{16}$/, 'artifactId matches expected format');

  // 2. persisted + owned (durable read)
  const owned = await world.artifactsOf('npc:u');
  assert.equal(owned.length, 1, 'one artifact in inventory');
  assert.equal(owned[0].name, '岩心之泪', 'artifact name matches');
  assert.equal(owned[0].ownedBy, 'npc:u', 'artifact ownedBy matches');

  // 3. can't afford → rejected, no debit
  const poor = await world.forgeArtifact({
    npcId: 'npc:u', kind: 'amulet', name: 'x', engraving: 'y', provenance: prov, costSilver: 999, now: 1001,
  });
  assert.equal(poor.ok, false, 'can-not-afford returns ok:false');
  assert.equal(poor.reason, 'insufficient_silver', 'reason is insufficient_silver');
  assert.equal((await world.balanceSilver('npc:u')), 60, 'silver unchanged on reject');

  console.log('forge-artifact.smoke.ts: PASS');
}

main().catch((err) => { console.error('FORGE-ARTIFACT SMOKE FAILED', err); process.exit(1); });
