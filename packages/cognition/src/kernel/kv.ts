import type { KV } from './port';

/** In-process KV — the default for trust persistence (and tests/offline). */
export class InMemoryKV implements KV {
  private m = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.m.has(key) ? this.m.get(key)! : null; }
  async set(key: string, val: string): Promise<void> { this.m.set(key, val); }
}
