import type { Discernment, RememberInput, SelectResult, DiscernOpts } from '../types';

/** The aigg-memory subset cognition uses. All ops are model-free EXCEPT reflect. */
export interface MemoryKernel {
  remember(corpus: string, fact: RememberInput): Promise<void>;
  discernment(corpus: string, topic: string, opts?: DiscernOpts): Promise<Discernment>;
  verify(corpus: string, opts?: { now?: string; refuteThreshold?: number }): Promise<{ verified: number; stale: number }>;
  select(corpus: string, request: string, opts?: { nBest?: number; kinds?: string[] }): Promise<SelectResult>;
  reflect(corpus: string, opts?: { now?: string }): Promise<{ beliefs: number }>;   // LLM — optional
}

/** Minimal key/value port for trust persistence (cognition stays standalone). */
export interface KV { get(key: string): Promise<string | null>; set(key: string, val: string): Promise<void>; }
