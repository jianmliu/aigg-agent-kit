/**
 * tick-committer — the DA seam (docs/WORLD_AS_DOMAIN.md §4): per tick, archive the
 * FULL event stream to DSN → get a CID, hash the blob for the on-chain anchor, and
 * call WorldBase.commitTick(stateRoot, eventsHash).
 *
 *   economic state  → executed on Auto EVM (PumpWorld)         [high stake, on-chain]
 *   full event blob → DSN (AutoDriveClient.upload) → CID        [permanent, content-addressed]
 *   commitTick      → {stateRoot, eventsHash} on Auto EVM       [tamper-evidence anchor]
 *
 * The on-chain eventsHash = keccak256(blob). Anyone fetches the blob from DSN by CID
 * and verifies keccak256(blob) == eventsHash → the archive can't be silently changed,
 * WITHOUT paying to store the blob on-chain. No real value moves here.
 */
import { keccak256, stringToHex, type Hex } from 'viem';
import { stateRoot, type WorldState, type WorldEvent } from './world-stf';
import type { AutoDriveClient } from '@aigg/npc-agent';

/** The per-tick blob archived to DSN (the REPLAY_SCHEMA tick frame / narrative body). */
export interface TickBlob {
  /** host blob schema id (default 'pumptown/tick@0'; e.g. 'pal/tick@0'). */
  schema: string;
  tick: number;
  /** the full event stream for the tick (say/trade/reflect/… — the low-stake body). */
  events: WorldEvent[];
  /** hex sha256 of the economic state (also committed on-chain as bytes32). */
  stateRoot: string;
  /** optional extra narrative/cognition the host wants permanently archived. */
  meta?: Record<string, unknown>;
}

/** Anchors a tick on-chain via WorldBase.commitTick(bytes32 stateRoot, bytes32 eventsCID). */
export interface TickAnchor {
  commit(tick: number, stateRootHex: Hex, eventsHash: Hex): Promise<{ txHash?: string }>;
}

export interface TickCommitResult {
  tick: number;
  stateRoot: Hex;   // 0x + sha256(economic state)
  eventsHash: Hex;  // keccak256(blob) — the on-chain tamper-evidence anchor
  cid: string;      // DSN locator
  txHash?: string;
}

/** keccak256 of the canonical tick blob string — the on-chain anchor over the DSN body. */
export function tickEventsHash(body: string): Hex {
  return keccak256(stringToHex(body));
}

/** Verify a blob fetched from DSN against the on-chain anchor (tamper-evidence check). */
export function verifyTickBlob(body: string, eventsHash: Hex): boolean {
  return tickEventsHash(body) === eventsHash;
}

/**
 * Commit one tick: archive the event blob to DSN, hash it for the on-chain anchor,
 * and call commitTick(stateRoot, eventsHash). Returns the CID + hashes + txHash.
 */
export class TickCommitter {
  constructor(
    private readonly drive: AutoDriveClient,
    private readonly anchor: TickAnchor,
    private readonly opts: { schema?: string } = {},
  ) {}

  async commit(state: WorldState, events: WorldEvent[], tick: number, meta?: Record<string, unknown>): Promise<TickCommitResult> {
    const root = stateRoot(state);                  // hex sha256 (32 bytes)
    const blob: TickBlob = { schema: this.opts.schema ?? 'pumptown/tick@0', tick, events, stateRoot: root, ...(meta ? { meta } : {}) };
    const body = JSON.stringify(blob);
    const cid = await this.drive.upload(body, `tick-${tick}.json`);   // → DSN
    const eventsHash = tickEventsHash(body);
    const stateRootHex = `0x${root}` as Hex;
    const { txHash } = await this.anchor.commit(tick, stateRootHex, eventsHash);
    return { tick, stateRoot: stateRootHex, eventsHash, cid, txHash };
  }
}

/** Real on-chain anchor: writeContract WorldBase.commitTick via an injected viem walletClient. */
const COMMIT_TICK_ABI = [{
  type: 'function', name: 'commitTick', stateMutability: 'nonpayable',
  inputs: [{ name: 'stateRoot', type: 'bytes32' }, { name: 'eventsCID', type: 'bytes32' }], outputs: [],
}] as const;

export interface ViemTickAnchorOptions {
  /** a viem WalletClient (with an account) able to send to the WorldBase contract. */
  walletClient: { writeContract: (args: Record<string, unknown>) => Promise<string> };
  /** the deployed WorldBase/PumpWorld address. */
  address: Hex;
}

export class ViemTickAnchor implements TickAnchor {
  constructor(private readonly opts: ViemTickAnchorOptions) {}
  async commit(_tick: number, stateRootHex: Hex, eventsHash: Hex): Promise<{ txHash?: string }> {
    const txHash = await this.opts.walletClient.writeContract({
      address: this.opts.address, abi: COMMIT_TICK_ABI, functionName: 'commitTick', args: [stateRootHex, eventsHash],
    });
    return { txHash };
  }
}
