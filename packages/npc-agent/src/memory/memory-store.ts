import type { Store, Scope, WriteOptions } from '../store/store';

function scopeKey(scope: Scope, key: string): string {
  switch (scope.type) {
    case 'npc-player':
      return `np:${scope.npcId}:${scope.playerId}:${key}`;
    case 'player':
      return `pl:${scope.playerId}:${key}`;
    case 'world':
      return `w:${key}`;
  }
}

/**
 * InMemoryStore — a Store backend with no persistence. Used for dev/headless
 * tests and as the default until IndexedDbStore (P0 ③b) lands. Records which
 * keys were written with `{ onchain: true }` so tests/inspection can see the
 * "would-go-onchain" set without any chain dependency.
 */
export class InMemoryStore implements Store {
  private readonly data = new Map<string, unknown>();
  readonly onchainKeys = new Set<string>();

  async get<T>(scope: Scope, key: string): Promise<T | null> {
    const k = scopeKey(scope, key);
    return this.data.has(k) ? (this.data.get(k) as T) : null;
  }

  async set<T>(scope: Scope, key: string, value: T, opts?: WriteOptions): Promise<void> {
    const k = scopeKey(scope, key);
    this.data.set(k, value);
    if (opts?.onchain) this.onchainKeys.add(k);
  }

  async delete(scope: Scope, key: string): Promise<void> {
    this.data.delete(scopeKey(scope, key));
  }
}
