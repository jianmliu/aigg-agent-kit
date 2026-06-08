/**
 * reflection-oracle — the REFLECTION faculty (Generative Agents' second pillar)
 * as an observe→synthesize→act decorator over any InferenceOracle.
 *
 * Reflection is what memory and planning are NOT: GENERALIZING across observations
 * into a higher-level insight that transfers to NEW situations.
 *   - memory   = recall THIS visitor's history (per-relationship continuity).
 *   - planning = foresight about the CURRENT think's visible value (a rule).
 *   - reflection = learn a per-TYPE value the current output does NOT reveal
 *     (hidden), by synthesizing realized outcomes — then skip the types that
 *     don't pay off, including ones met for the first time.
 *
 * Economically: `observe(input, realizedValue)` feeds back what each interaction
 * actually earned; every `every` engaged thinks it REFLECTS (costs GCC, like a
 * think) to recompute a type→value policy; then it RESTS on types whose learned
 * value < a think's cost. A non-reflector bleeds GCC on hidden-low-value types
 * forever; a reflector learns to stop. Measured by net earn / wealth, on/off — no
 * text grading. (A planner can't help here: the per-turn output looks identical
 * across types, so its value rule can't tell them apart — only reflection can.)
 */
import type { InferenceOracle, OracleInput, OracleOutput } from './inference-oracle';

export interface ReflectionOracleOptions {
  inner: InferenceOracle;
  /** observable visitor "type" label (value is hidden; learned from outcomes). */
  typeOf: (input: OracleInput) => string;
  /** reflect every N engaged thinks (synthesize observations → policy). */
  every: number;
  /** GCC cost of a reflection (it is itself a think). */
  cost: number;
  restLine?: string;
}

export class ReflectionOracle implements InferenceOracle {
  private readonly obs: Record<string, { sum: number; n: number }> = {};
  private policy: Record<string, number> = {}; // type → learned avg realized value (post-reflection)
  private since = 0;

  constructor(private readonly o: ReflectionOracleOptions) {}

  async produce(input: OracleInput): Promise<OracleOutput> {
    const type = this.o.typeOf(input);
    const out = await this.o.inner.produce(input);
    if (out.gccCost <= 0) return out;
    // exploit the learned insight: skip types whose learned value can't cover a think.
    const learned = this.policy[type];
    if (learned != null && learned < out.gccCost) {
      return { say: this.o.restLine ?? '（若有所思）', effects: [], gccCost: 0 };
    }
    // periodic reflection — synthesize observations into the policy (costs GCC).
    if (++this.since >= this.o.every) {
      this.since = 0;
      this.policy = Object.fromEntries(Object.entries(this.obs).map(([k, s]) => [k, s.n ? s.sum / s.n : 0]));
      return { ...out, gccCost: out.gccCost + this.o.cost };
    }
    return out;
  }

  /** feed back the realized value (e.g. GCC earned) of an interaction — reflection's raw material. */
  observe(input: OracleInput, realizedValue: number): void {
    const type = this.o.typeOf(input);
    const s = this.obs[type] ?? (this.obs[type] = { sum: 0, n: 0 });
    s.sum += realizedValue; s.n++;
  }
}
