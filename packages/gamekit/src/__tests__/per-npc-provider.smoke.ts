/**
 * per-npc-provider smoke — SharedWorld routes each NPC's cognition to its OWN
 * brain. Two NPCs, two distinct providers (one stamps a 0G-style attestation,
 * the other a dstack-style one); talking to each must reach the right provider
 * and carry the right verdict. Proves "one NPC thinks on 0G, another on the
 * Auto EVM market" in a single town.
 *
 * Run: tsx src/__tests__/per-npc-provider.smoke.ts
 */
import assert from 'node:assert/strict';
import { InMemoryStore } from '@aigg/npc-agent';
import type { InferenceProvider, InferenceResult } from '@aigg/npc-agent';
import { SharedWorld } from '../shared-world';

/** A provider that always says a fixed line and stamps a given attestation sig,
 *  recording every prompt it was asked so we can assert routing. */
function fakeProvider(id: string, say: string, sig: string): InferenceProvider & { calls: number } {
  const p = {
    id,
    calls: 0,
    async complete(): Promise<InferenceResult> {
      p.calls++;
      // The LlmAgent expects a JSON intent; return the minimal shape it parses.
      return {
        text: JSON.stringify({ say, effects: [] }),
        usage: { model: id, inputTokens: 3, outputTokens: 5, gccCost: 0.001 },
        attestation: { model: id, promptHash: '0x', responseHash: '0x', signature: sig },
      };
    },
  };
  return p;
}

async function main() {
  const zerog = fakeProvider('0g-broker', 'A-Bao: the tea is hot tonight.', '0g-teeml:verified:chatA');
  const autopal = fakeProvider('autopal-broker', 'Mei: fresh fish, verified on-chain.', 'dstack:verified:respB');
  // a default provider that must NOT be hit for the two bound NPCs.
  const fallback = fakeProvider('fallback', 'nobody', 'none');

  const world = new SharedWorld({ store: new InMemoryStore(), provider: fallback, rooms: ['Market'] });

  // Bind at creation: A-Bao thinks on 0G, Mei on the Auto EVM market.
  await world.createNpc({ id: 'npc:abao', name: 'A-Bao', owner: 'sys', background: 'tea seller', startGcc: 5, provider: zerog });
  await world.createNpc({ id: 'npc:mei', name: 'Mei', owner: 'sys', background: 'fishmonger', startGcc: 5, provider: autopal });

  const a = await world.talk({ npcId: 'npc:abao', visitorId: 'v1', text: 'evening', lang: 'en' });
  const m = await world.talk({ npcId: 'npc:mei', visitorId: 'v1', text: 'evening', lang: 'en' });

  // Each reached ONLY its own provider.
  assert.equal(zerog.calls, 1, 'A-Bao routed to the 0G provider exactly once');
  assert.equal(autopal.calls, 1, 'Mei routed to the Auto EVM provider exactly once');
  assert.equal(fallback.calls, 0, 'default provider must not be hit for bound NPCs');

  // Each carries its own market's attestation.
  assert.equal(a.attestation?.signature, '0g-teeml:verified:chatA', 'A-Bao thought carries the 0G verdict');
  assert.equal(m.attestation?.signature, 'dstack:verified:respB', 'Mei thought carries the Auto EVM verdict');
  assert.ok(String(a.said).includes('tea'), 'A-Bao said the 0G provider line');
  assert.ok(String(m.said).includes('fish'), 'Mei said the Auto EVM provider line');

  // setNpcProvider re-binds after creation: move A-Bao onto the market too.
  world.setNpcProvider('npc:abao', autopal);
  await world.talk({ npcId: 'npc:abao', visitorId: 'v1', text: 'again', lang: 'en' });
  assert.equal(autopal.calls, 2, 'A-Bao now routed to the Auto EVM provider after re-bind');
  assert.equal(zerog.calls, 1, '0G provider not hit again after re-bind');

  // An UNBOUND NPC falls back to the default provider.
  await world.createNpc({ id: 'npc:liu', name: 'Liu', owner: 'sys', background: 'keeper', startGcc: 5 });
  await world.talk({ npcId: 'npc:liu', visitorId: 'v1', text: 'hi', lang: 'en' });
  assert.equal(fallback.calls, 1, 'unbound NPC uses the default provider');

  console.log('per-npc-provider smoke: OK — 0G + Auto EVM brains coexist, routed per NPC');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
