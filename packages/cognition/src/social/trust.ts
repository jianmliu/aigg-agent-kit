import type { KV } from '../kernel/port';
import { InMemoryKV } from '../kernel/kv';
import { corpusId } from '../id';

/** Outcome → trust delta. The -0.3 scammed delta mirrors monopoly's trust events. */
export const TRUST_DELTAS = { scammed: -0.3, brokenPromise: -0.2, honestDeal: 0.05, kept: 0.1 } as const;

const clamp = (x: number) => Math.max(-1, Math.min(1, x));
const key = (self: string, peer: string) => `trust:${corpusId(self)}:${corpusId(peer)}`;

/** Per-(self,peer) trust scalar in [-1,1], neutral prior 0, persisted via an injected KV. */
export class TrustLedger {
  constructor(private kv: KV = new InMemoryKV()) {}

  async get(self: string, peer: string): Promise<number> {
    const v = await this.kv.get(key(self, peer));
    return v == null ? 0 : Number(v);
  }

  async update(self: string, peer: string, delta: number): Promise<number> {
    const next = clamp((await this.get(self, peer)) + delta);
    await this.kv.set(key(self, peer), String(next));
    return next;
  }
}
