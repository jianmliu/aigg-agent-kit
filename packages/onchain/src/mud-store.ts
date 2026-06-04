/**
 * MudStore — the on-chain **state** backend for the npc-agent `Store` seam, using
 * Lattice MUD's ECS tables. This is the second on-chain layer, complementary to
 * the GCC payment layer (wallet-svc / facilitator): MUD persists WORLD STATE
 * (player position, NPC↔player relationship/affinity, GCC balances, donations)
 * on-chain as ECS records.
 *
 * Design (per the Store comment "the {onchain:true} subset → MUD tables"):
 *  - every write goes to a fast/full `local` Store (default InMemoryStore);
 *  - writes tagged `{ onchain: true }` are ALSO mirrored to MUD via an injectable
 *    `MudKvClient` (so the on-chain copy = the canonical record for that subset);
 *  - reads come from `local` (the full mirror).
 *
 * `MudKvClient` is injectable so this stays framework-light (viem only, for the
 * key hash). The real client wraps a deployed MUD World (recs/viem `setRecord`
 * on a generic key→value table, or per-concept tables); a fake one backs tests.
 */
import { keccak256, toBytes } from 'viem';
import { InMemoryStore } from '@onchainpal/npc-agent';
import type { Store, Scope, WriteOptions } from '@onchainpal/npc-agent';

/** Minimal generic key→value surface over a MUD World (records as JSON strings). */
export interface MudKvClient {
  setRecord(key: `0x${string}`, valueJson: string): Promise<void>;
  getRecord(key: `0x${string}`): Promise<string | null>;
  deleteRecord(key: `0x${string}`): Promise<void>;
}

export interface MudStoreOptions {
  client: MudKvClient;
  /** full/fast mirror for reads + non-onchain writes (default InMemoryStore). */
  local?: Store;
}

/** Stable string id for a (scope,key) — hashed to bytes32 for the MUD key. */
export function scopeKeyId(scope: Scope, key: string): string {
  if (scope.type === 'npc-player') return `np|${scope.npcId}|${scope.playerId}|${key}`;
  if (scope.type === 'player') return `p|${scope.playerId}|${key}`;
  return `w|${key}`;
}
export const mudKey = (scope: Scope, key: string): `0x${string}` => keccak256(toBytes(scopeKeyId(scope, key)));

export class MudStore implements Store {
  private readonly client: MudKvClient;
  private readonly local: Store;

  constructor(opts: MudStoreOptions) {
    this.client = opts.client;
    this.local = opts.local ?? new InMemoryStore();
  }

  async get<T>(scope: Scope, key: string): Promise<T | null> {
    return this.local.get<T>(scope, key);
  }

  async set<T>(scope: Scope, key: string, value: T, opts?: WriteOptions): Promise<void> {
    await this.local.set(scope, key, value, opts);
    if (opts?.onchain) {
      await this.client.setRecord(mudKey(scope, key), JSON.stringify(value));
    }
  }

  async delete(scope: Scope, key: string): Promise<void> {
    await this.local.delete(scope, key);
    await this.client.deleteRecord(mudKey(scope, key));
  }

  /** Read the canonical on-chain copy (from MUD), bypassing the local mirror. */
  async getOnchain<T>(scope: Scope, key: string): Promise<T | null> {
    const raw = await this.client.getRecord(mudKey(scope, key));
    return raw == null ? null : (JSON.parse(raw) as T);
  }
}
