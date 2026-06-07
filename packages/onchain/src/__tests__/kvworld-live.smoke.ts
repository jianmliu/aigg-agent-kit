/**
 * LIVE cross-server smoke — proves the trustless head-index path end to end
 * against a REAL chain (anvil), through the full production store stack:
 *
 *     AutoDriveStore (git-like memory chain)
 *       ├─ client:    shared DSN blobs (global, content-addressed)
 *       └─ headIndex: MudStore → KvWorld (on-chain, global mutable head pointer)
 *
 * The cross-server property is simulated faithfully: TWO independent store
 * stacks (server A, server B) share NOTHING in memory — only (a) the on-chain
 * KvWorld and (b) the content-addressed blob store. Server A authors an NPC;
 * server B, with its own fresh MudStore + AutoDriveStore, recovers it by reading
 * the head CID from chain and the blob from the shared DSN. That is exactly what
 * a second mud-server instance pointed at the same World + DSN would do.
 *
 * Env-gated (like auto-respawn-live): runs only when WORLD/RPC_URL/PRIVATE_KEY
 * are set. Bring up the chain first:
 *     anvil --silent &
 *     forge create src/KvWorld.sol:KvWorld --rpc-url http://127.0.0.1:8545 \
 *       --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 --broadcast
 *     WORLD=<deployed> RPC_URL=http://127.0.0.1:8545 \
 *       PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
 *       tsx src/__tests__/kvworld-live.smoke.ts
 */
import assert from 'node:assert/strict';
import {
  createWalletClient, createPublicClient, http, stringToHex, hexToString, encodeFunctionData,
  type Hex, type PublicClient, type WalletClient, type Account,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { InMemoryStore, AutoDriveStore, type AutoDriveClient, type Scope } from '@onchainpal/npc-agent';
import { MudStore, type MudKvClient } from '../mud-store';

// ── inline viem KvClient — mirrors mud-demo's MudWorldKvClient ABI exactly ──────
// KvWorld ignores the MUD routing ids (tableId/systemId), so we pass zero bytes32;
// the production MudWorldKvClient passes resourceToHex(...) ids — both work.
const ZERO32 = ('0x' + '00'.repeat(32)) as Hex;
const WORLD_CALL_ABI = [{ type: 'function', name: 'call', stateMutability: 'payable', inputs: [{ name: 'systemId', type: 'bytes32' }, { name: 'callData', type: 'bytes' }], outputs: [{ name: '', type: 'bytes' }] }] as const;
const ISTORE_ABI = [{ type: 'function', name: 'getRecord', stateMutability: 'view', inputs: [{ name: 'tableId', type: 'bytes32' }, { name: 'keyTuple', type: 'bytes32[]' }], outputs: [{ name: 'staticData', type: 'bytes' }, { name: 'encodedLengths', type: 'bytes32' }, { name: 'dynamicData', type: 'bytes' }] }] as const;
const KVSYSTEM_ABI = [
  { type: 'function', name: 'kvSet', stateMutability: 'nonpayable', inputs: [{ name: 'key', type: 'bytes32' }, { name: 'value', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'kvDel', stateMutability: 'nonpayable', inputs: [{ name: 'key', type: 'bytes32' }], outputs: [] },
] as const;

class ViemKvClient implements MudKvClient {
  private readonly world: Hex;
  private readonly wallet: WalletClient;
  private readonly pub: PublicClient;
  private readonly account: Account;
  constructor(world: Hex, rpcUrl: string, pk: Hex) {
    this.world = world;
    this.account = privateKeyToAccount(pk);
    this.wallet = createWalletClient({ account: this.account, transport: http(rpcUrl) });
    this.pub = createPublicClient({ transport: http(rpcUrl) });
  }
  private async callSystem(callData: Hex): Promise<void> {
    const hash = await this.wallet.writeContract({ address: this.world, abi: WORLD_CALL_ABI, functionName: 'call', account: this.account, chain: null, args: [ZERO32, callData] });
    await this.pub.waitForTransactionReceipt({ hash });
  }
  async setRecord(key: Hex, valueJson: string): Promise<void> {
    await this.callSystem(encodeFunctionData({ abi: KVSYSTEM_ABI, functionName: 'kvSet', args: [key, stringToHex(valueJson)] }));
  }
  async getRecord(key: Hex): Promise<string | null> {
    const res = (await this.pub.readContract({ address: this.world, abi: ISTORE_ABI, functionName: 'getRecord', args: [ZERO32, [key]] })) as [Hex, Hex, Hex];
    return !res[2] || res[2] === '0x' ? null : hexToString(res[2]);
  }
  async deleteRecord(key: Hex): Promise<void> {
    await this.callSystem(encodeFunctionData({ abi: KVSYSTEM_ABI, functionName: 'kvDel', args: [key] }));
  }
}

/**
 * Read-retry — public RPCs (e.g. sepolia.base.org) are load-balanced, so an
 * eth_call right after a confirmed write can hit a node a block behind and
 * return stale/empty. Production cross-server reads happen seconds+ after the
 * write (no issue); this same-process read-after-write is the worst case, so we
 * poll until the value propagates. NOT a contract or client concern.
 */
async function readUntil<T>(fn: () => Promise<T>, ok: (v: T) => boolean, label: string, tries = 30, delayMs = 2000): Promise<T> {
  let last: T;
  for (let i = 0; i < tries; i++) {
    last = await fn();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`readUntil timed out (${tries * delayMs / 1000}s): ${label}`);
}

/** shared, content-addressed blob store — the global DSN both servers can reach. */
function sharedDsn(): AutoDriveClient {
  const blobs = new Map<string, string>();
  let n = 0;
  return {
    async upload(data, name) { const cid = `cid:${name}:${n++}`; blobs.set(cid, data); return cid; },
    async download(cid) { const d = blobs.get(cid); if (d == null) throw new Error(`no blob ${cid}`); return d; },
  };
}

async function main() {
  const world = process.env.WORLD as Hex | undefined;
  const rpcUrl = process.env.RPC_URL;
  const pk = process.env.PRIVATE_KEY as Hex | undefined;
  if (!world || !rpcUrl || !pk) {
    console.log('KVWORLD-LIVE SMOKE SKIPPED — set WORLD/RPC_URL/PRIVATE_KEY (anvil + deployed KvWorld) to run');
    return;
  }
  const W: Scope = { type: 'world' };

  // ── 1. raw KV round-trip through KvWorld ────────────────────────────────────
  const client = new ViemKvClient(world, rpcUrl, pk);
  const key = ('0x' + 'ab'.repeat(32)) as Hex;
  await client.setRecord(key, '{"head":"cid:abc"}');
  assert.equal(await readUntil(() => client.getRecord(key), (v) => v === '{"head":"cid:abc"}', 'raw round-trip'), '{"head":"cid:abc"}', 'KvWorld set→get round-trips on-chain');
  const missing = ('0x' + 'cd'.repeat(32)) as Hex;
  assert.equal(await client.getRecord(missing), null, 'absent key → null (empty dynamicData)');
  console.log('  ✓ KvWorld raw KV round-trip on real chain');

  // ── 2. MudStore over KvWorld: {onchain:true} subset mirrored to chain ────────
  const ms = new MudStore({ client, readThrough: true });
  await ms.set(W, 'world:npcs', ['npc:酒剑仙'], { onchain: true });
  assert.deepEqual(await readUntil(() => ms.getOnchain<string[]>(W, 'world:npcs'), (v) => Array.isArray(v) && v[0] === 'npc:酒剑仙', 'registry'), ['npc:酒剑仙'], 'registry readable from chain');
  console.log('  ✓ MudStore registry write → readable on-chain');

  // ── 3. CROSS-SERVER convergence: two independent stacks, shared chain+DSN ────
  const dsn = sharedDsn(); // the one global blob store both servers reach
  const serverA = new AutoDriveStore({ client: dsn, headIndex: new MudStore({ client: new ViemKvClient(world, rpcUrl, pk), readThrough: true }) });
  const serverB = new AutoDriveStore({ client: dsn, headIndex: new MudStore({ client: new ViemKvClient(world, rpcUrl, pk), readThrough: true }) });

  const npcKey = 'npc:npc:酒剑仙';
  const identity = { id: 'npc:酒剑仙', name: '酒剑仙', owner: 'player:A', room: '酒馆', background: '嗜酒如命的剑道高人' };
  await serverA.set(W, npcKey, identity, { onchain: true }); // A authors → head CID on chain, blob in shared DSN

  const recovered = await readUntil(() => serverB.get<typeof identity>(W, npcKey), (v) => v?.name === '酒剑仙', 'cross-server recover'); // B has its OWN fresh stack
  assert.deepEqual(recovered, identity, 'server B recovers A’s NPC via on-chain head + shared DSN blob (CROSS-SERVER)');
  console.log('  ✓ cross-server convergence: server B recovered server A’s NPC from chain head + shared DSN');

  // ── 4. git-like history walkable across servers ─────────────────────────────
  await serverA.set(W, npcKey, { ...identity, room: '广场' }, { onchain: true }); // A moves it
  const moved = await readUntil(() => serverB.get<typeof identity>(W, npcKey), (v) => v?.room === '广场', 'cross-server update');
  assert.equal((moved as typeof identity).room, '广场', 'server B sees the update (head advanced on chain)');
  const hist = await serverB.history(W, npcKey);
  assert.ok(hist.length >= 2, `git-like history walkable cross-server (${hist.length} nodes)`);
  console.log(`  ✓ update propagates + ${hist.length}-node history walkable from server B`);

  console.log('\nKVWORLD-LIVE (cross-server) SMOKE PASSED ✅');
}

main().catch((err) => { console.error('KVWORLD-LIVE SMOKE FAILED ❌', err); process.exit(1); });
