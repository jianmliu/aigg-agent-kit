import type { WriteOptions } from './write-options';

export type { WriteOptions } from './write-options';

/**
 * Scope — the addressing space for persisted state. The scope makes the
 * per-(NPC × player) memory model explicit and lets the onchain backend later
 * map scopes to MUD table keys.
 */
export type Scope =
  | { type: 'npc-player'; npcId: string; playerId: string }
  | { type: 'player'; playerId: string }
  | { type: 'world' };

/**
 * Store — the single persistence seam. Backends are swappable:
 *   v1  IndexedDbStore (local, durable)
 *   v2  MudStore       (the `onchain: true` subset → contracts/world tables)
 *
 * The set of keys ever written with `{ onchain: true }` IS the onchain schema:
 * defining it here is how we design the contracts without touching Solidity yet.
 */
export interface Store {
  get<T>(scope: Scope, key: string): Promise<T | null>;
  set<T>(scope: Scope, key: string, value: T, opts?: WriteOptions): Promise<void>;
  delete(scope: Scope, key: string): Promise<void>;
}
