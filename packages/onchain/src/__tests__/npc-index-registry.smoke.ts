/**
 * Smoke: NpcIndexRegistry assigns collision-free sequential indices, is stable
 * per npcId, survives a persist/reload round-trip, and npcSelector builds the
 * structured wallet-svc selector. Run: tsx src/__tests__/npc-index-registry.smoke.ts
 */
import assert from 'node:assert';
import { InMemoryNpcIndexRegistry, npcSelector } from '../npc-index-registry';

function main() {
  const reg = new InMemoryNpcIndexRegistry();

  // Sequential + stable.
  assert.equal(reg.indexFor('npc:a'), 0, 'first npc → 0');
  assert.equal(reg.indexFor('npc:b'), 1, 'second npc → 1');
  assert.equal(reg.indexFor('npc:a'), 0, 'npc:a stable across calls');
  assert.equal(reg.indexFor('npc:c'), 2, 'third npc → 2');
  assert.equal(reg.has('npc:b'), true);
  assert.equal(reg.has('npc:z'), false);

  // Persist → reload resumes without re-assigning or colliding.
  const persisted = reg.entries();
  const reg2 = new InMemoryNpcIndexRegistry(persisted);
  assert.equal(reg2.indexFor('npc:a'), 0, 'reload keeps npc:a=0');
  assert.equal(reg2.indexFor('npc:b'), 1, 'reload keeps npc:b=1');
  assert.equal(reg2.indexFor('npc:new'), 3, 'reload assigns next free = 3 (no collision with 0..2)');

  // No two distinct npcs share an index.
  const seen = new Set<number>();
  for (const [, idx] of reg2.entries()) {
    assert.equal(seen.has(idx), false, `index ${idx} is unique`);
    seen.add(idx);
  }

  // npcSelector wraps owner + index; rejects a bad owner.
  assert.deepEqual(npcSelector(42, reg2, 'npc:a'), { owner: 42, agent: 0 });
  assert.deepEqual(npcSelector(42, reg2, 'npc:new'), { owner: 42, agent: 3 });
  assert.throws(() => npcSelector(0, reg2, 'npc:a'), /AIGG_OWNER_ID/, 'owner < 1 rejected');

  console.log('NPC-INDEX-REGISTRY SMOKE PASSED ✅');
}

main();
