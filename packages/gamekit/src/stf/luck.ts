/**
 * luck — the seeded exogenous-shock stream for the Talent-vs-Luck experiment
 * (Pluchino, Biondo & Rapisarda 2018, in a generative-agent economy).
 *
 * The randomness lives HERE, in a seedable PRNG OUTSIDE the deterministic STF.
 * `rollLuck` turns rng draws into `luckEvent` txs that the STF applies purely —
 * so a run is fully reproducible from (seed, config): same seed → same luck
 * stream → same stateRoot. That is the counterfactual-replay superpower: hold
 * the luck seed fixed and swap a model to isolate talent's causal contribution.
 *
 * NB: never uses Math.random (which is banned in the STF and breaks replay).
 */
import type { WorldTx } from './world-stf';

export type LuckEventTx = Extract<WorldTx, { type: 'luckEvent' }>;

/** mulberry32 — a tiny, fast, fully-seedable PRNG. Deterministic by construction. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface LuckConfig {
  /** 'mul' = multiplicative (balance *= factor; heavy-tailed, the TvL regime);
   *  'add' = additive (balance += amount; tests whether talent beats flat noise). */
  mode: 'add' | 'mul';
  /** per-eligible-tick probability that a luck event fires for an NPC. */
  prob: number;
  /** good magnitude — mul: factor>1 (e.g. 1.5); add: +gcc (e.g. 0.02). */
  good: number;
  /** bad magnitude — mul: factor<1 (e.g. 0.5); add: the POSITIVE size of the loss (applied as −). */
  bad: number;
  /** P(event is good | event fires). Default 0.5 (fair coin). */
  goodBias?: number;
}

/**
 * Draw at most one luck event for `npcId` at `now` from the shared rng. Returns
 * null if no event this tick. Pass the SAME rng across the whole run so the seed
 * determines the entire stream.
 */
export function rollLuck(rng: () => number, npcId: string, cfg: LuckConfig, now: number): LuckEventTx | null {
  if (rng() >= cfg.prob) return null;
  const good = rng() < (cfg.goodBias ?? 0.5);
  if (cfg.mode === 'mul') {
    return { type: 'luckEvent', npcId, gccFactor: good ? cfg.good : cfg.bad, label: good ? 'good:mul' : 'bad:mul', now };
  }
  return { type: 'luckEvent', npcId, gccDelta: good ? cfg.good : -cfg.bad, label: good ? 'good:add' : 'bad:add', now };
}
