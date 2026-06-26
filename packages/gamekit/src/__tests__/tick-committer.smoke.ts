/**
 * tick-committer smoke — the DA seam (docs/WORLD_AS_DOMAIN.md §4) end-to-end with a
 * fake DSN (content-addressed in-memory) + in-memory anchor:
 *   commit tick → blob archived to DSN (CID) → commitTick(stateRoot,eventsHash) called
 *   → re-download by CID → keccak256(blob) == on-chain eventsHash (tamper-evidence)
 *   → tampering the stored blob breaks the check.
 *
 * Run: npx tsx src/__tests__/tick-committer.smoke.ts
 */
import assert from 'node:assert/strict';
import { keccak256, stringToHex, type Hex } from 'viem';
import { DefaultGameRules } from '@aigg/npc-agent';
import type { AutoDriveClient } from '@aigg/npc-agent';
import { applyTx, emptyWorld, stateRoot, type WorldState, type WorldTx, type WorldEvent } from '../stf/world-stf';
import { TickCommitter, verifyTickBlob, tickEventsHash, type TickAnchor } from '../stf/tick-committer';

// content-addressed fake DSN: cid = keccak(body); tamper() lets a test corrupt a blob
class FakeDrive implements AutoDriveClient {
  store = new Map<string, string>();
  async upload(data: string): Promise<string> {
    const cid = 'cid:' + keccak256(stringToHex(data)).slice(2, 18);
    this.store.set(cid, data);
    return cid;
  }
  async download(cid: string): Promise<string> {
    const v = this.store.get(cid);
    if (v === undefined) throw new Error(`no blob ${cid}`);
    return v;
  }
  tamper(cid: string, newBody: string) { this.store.set(cid, newBody); }
}

class InMemoryAnchor implements TickAnchor {
  calls: Array<{ tick: number; stateRoot: Hex; eventsHash: Hex }> = [];
  async commit(tick: number, stateRootHex: Hex, eventsHash: Hex) {
    this.calls.push({ tick, stateRoot: stateRootHex, eventsHash });
    return { txHash: '0xtx' + tick };
  }
}

const rules = new DefaultGameRules();
const apply = (s: WorldState, tx: WorldTx) => applyTx(s, tx, rules);

async function main() {
  console.log('=== tick-committer smoke (DA seam: tick → DSN blob → on-chain anchor) ===\n');
  const drive = new FakeDrive();
  const anchor = new InMemoryAnchor();
  const committer = new TickCommitter(drive, anchor);

  // tick 1: a couple of economic txs → events
  let s: WorldState = apply(emptyWorld(), { type: 'initMarket', riceReserve: 1000, silverReserve: 100, supply: 1000 }).state;
  s.usdc = { a1: 50 };
  const r1 = apply(s, { type: 'trade', agentId: 'a1', side: 'buy', amountIn: 10, now: 1 });
  s = r1.state;
  const events1: WorldEvent[] = r1.events;

  const c1 = await committer.commit(s, events1, 1);
  assert.ok(c1.cid.startsWith('cid:'), 'tick archived to DSN → CID');
  assert.equal(c1.txHash, '0xtx1', 'commitTick called (anchored)');
  assert.equal(c1.stateRoot, `0x${stateRoot(s)}`, 'on-chain stateRoot = 0x + sha256(economic state)');
  assert.equal(anchor.calls.length, 1);
  assert.equal(anchor.calls[0].eventsHash, c1.eventsHash, 'anchor got the events hash');
  console.log('  ✓ commit: blob → DSN CID, commitTick(stateRoot, eventsHash) anchored');

  // tamper-evidence: re-download by CID → keccak matches the on-chain anchor
  const body = await drive.download(c1.cid);
  assert.ok(verifyTickBlob(body, c1.eventsHash), 're-fetched DSN blob matches on-chain eventsHash');
  assert.equal(tickEventsHash(body), c1.eventsHash, 'keccak256(blob) == committed eventsHash');
  console.log('  ✓ tamper-evidence: re-fetched blob hashes to the on-chain anchor');

  // tamper the DSN blob → the on-chain anchor no longer matches (detected)
  drive.tamper(c1.cid, body.replace('"tick":1', '"tick":1,"evil":true'));
  const tampered = await drive.download(c1.cid);
  assert.ok(!verifyTickBlob(tampered, c1.eventsHash), 'tampered blob fails the hash check (detected)');
  console.log('  ✓ tampering the DSN blob breaks the on-chain hash check (caught)');

  // tick 2: tick increments, distinct CID/hash; deterministic hashing
  const r2 = apply(s, { type: 'trade', agentId: 'a1', side: 'sell', amountIn: 5, now: 2 });
  const c2 = await committer.commit(r2.state, r2.events, 2);
  assert.equal(c2.tick, 2);
  assert.notEqual(c2.cid, c1.cid, 'different tick → different blob/CID');
  assert.notEqual(c2.eventsHash, c1.eventsHash, 'different events → different anchor');
  assert.equal(anchor.calls.length, 2, 'both ticks anchored');
  // deterministic: same body → same hash
  const fresh = await drive.download(c2.cid);
  assert.equal(tickEventsHash(fresh), c2.eventsHash, 'hashing is deterministic');
  console.log('  ✓ ticks increment; distinct CID+hash per tick; hashing deterministic');

  console.log('\nTICK-COMMITTER SMOKE PASSED ✅');
}

main().catch((e) => { console.error('TICK-COMMITTER SMOKE FAILED ❌', e); process.exit(1); });
