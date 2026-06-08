/**
 * planning-oracle — the PLANNING faculty (Generative Agents' third pillar) as a
 * budget-aware decorator over any InferenceOracle.
 *
 * In a metered-cognition economy, planning = METABOLIC FORESIGHT, two rules:
 *   (1) value: don't PAY to think when the think won't pay for itself
 *       (expected GCC return < its gccCost) — skip net-negative interactions
 *       instead of bleeding GCC on every passer-by.
 *   (2) reserve: don't think this turn if doing so would drop below a buffer —
 *       keep runway against shocks rather than spending to the edge of starvation.
 * A reactive oracle (no rules) thinks regardless → bleeds on low-value visits and
 * starves; a planner survives and recovers (Talent-vs-Luck H2: capability = shock
 * resilience). The faculty is thus measurable by wealth/survival under a fixed
 * visitor+shock schedule — no text grading, fully replayable.
 */
import type { InferenceOracle, OracleInput, OracleOutput } from './inference-oracle';

export interface PlanningOracleOptions {
  inner: InferenceOracle;
  /** expected GCC return of a think (e.g. patronRate × affinity gain); rest if < gccCost. */
  value?: (out: OracleOutput, input: OracleInput) => number;
  /** GCC buffer to preserve — rest if a think would drop below it. */
  reserve?: number;
  /** line spoken while conserving (no effects, no cost). */
  restLine?: string;
}

export class PlanningOracle implements InferenceOracle {
  constructor(private readonly o: PlanningOracleOptions) {}

  async produce(input: OracleInput): Promise<OracleOutput> {
    const out = await this.o.inner.produce(input);
    if (out.gccCost <= 0) return out;
    const bal = input.balanceGcc ?? 0;
    const notWorthIt = this.o.value != null && this.o.value(out, input) < out.gccCost;
    const breachesReserve = this.o.reserve != null && bal - out.gccCost < this.o.reserve;
    if (notWorthIt || breachesReserve) {
      return { say: this.o.restLine ?? '（养精蓄锐）', effects: [], gccCost: 0 }; // foresight: conserve
    }
    return out;
  }
}
