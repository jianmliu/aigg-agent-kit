/**
 * Headless smoke for MudStore — the on-chain state backend. A fake MudKvClient
 * (in-memory) stands in for a deployed MUD World; verifies the {onchain:true}
 * subset is mirrored to MUD while everything is kept in the local mirror.
 * Run: pnpm --filter @onchainpal/onchain test:mudstore
 */
import assert from 'node:assert/strict';
import { InMemoryStore } from '@onchainpal/npc-agent';
import type { Scope } from '@onchainpal/npc-agent';
import { MudStore, mudKey, type MudKvClient } from '../mud-store';

class FakeMud implements MudKvClient {
  records = new Map<string, string>();
  sets = 0; deletes = 0;
  async setRecord(k: `0x${string}`, v: string) { this.sets++; this.records.set(k, v); }
  async getRecord(k: `0x${string}`) { return this.records.get(k) ?? null; }
  async deleteRecord(k: `0x${string}`) { this.deletes++; this.records.delete(k); }
}

async function main() {
  const mud = new FakeMud();
  const local = new InMemoryStore();
  const store = new MudStore({ client: mud, local });

  const rel: Scope = { type: 'npc-player', npcId: 'npc:jiu-jianxian', playerId: 'player:hero' };
  const world: Scope = { type: 'world' };

  // onchain-tagged write → local + MUD
  await store.set(rel, 'affinity', { value: 11 }, { onchain: true });
  assert.deepEqual(await store.get(rel, 'affinity'), { value: 11 }, 'readable from local mirror');
  assert.equal(mud.sets, 1, 'onchain write mirrored to MUD');
  assert.deepEqual(await store.getOnchain(rel, 'affinity'), { value: 11 }, 'canonical copy readable from MUD');
  assert.equal(mud.records.get(mudKey(rel, 'affinity')), JSON.stringify({ value: 11 }), 'stored under keccak(scope|key)');

  // non-onchain write → local only, NOT MUD
  await store.set(rel, 'scratch', { tmp: 1 });
  assert.deepEqual(await store.get(rel, 'scratch'), { tmp: 1 });
  assert.equal(mud.sets, 1, 'non-onchain write did NOT hit MUD');
  assert.equal(await store.getOnchain(rel, 'scratch'), null, 'scratch absent on-chain');

  // distinct scopes/keys → distinct MUD keys
  await store.set(world, 'gcc-ledger:npc:azhu', { gccSpent: 0.0015 }, { onchain: true });
  assert.notEqual(mudKey(rel, 'affinity'), mudKey(world, 'gcc-ledger:npc:azhu'), 'scope+key → distinct bytes32');
  assert.equal(mud.sets, 2);

  // delete clears both
  await store.delete(rel, 'affinity');
  assert.equal(await store.get(rel, 'affinity'), null, 'gone from local');
  assert.equal(await store.getOnchain(rel, 'affinity'), null, 'gone from MUD');
  assert.equal(mud.deletes, 1);

  // mudKey deterministic + 32-byte
  assert.equal(mudKey(rel, 'affinity'), mudKey(rel, 'affinity'));
  assert.match(mudKey(rel, 'affinity'), /^0x[0-9a-f]{64}$/i);

  console.log('✓ MudStore: onchain subset mirrored to MUD, local full mirror, deterministic keys, delete both');
  console.log('\nMUD-STORE SMOKE PASSED ✅');
}

main().catch((err) => { console.error('MUD-STORE SMOKE FAILED ❌', err); process.exit(1); });
