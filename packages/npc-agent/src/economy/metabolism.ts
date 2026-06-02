import type { AgentIntent } from '../intent/agent-intent';

/**
 * Metabolism — maps an NPC's GCC balance to its "cognitive state": which model
 * tier it can afford to think with, and whether it can think at all. This is the
 * I-phase mechanic: donated/earned GCC literally powers the NPC's mind. A broke
 * NPC falls back to scripted lines (no LLM call, no GCC burn); a well-funded one
 * thinks with a stronger model.
 *
 * Pure + engine-neutral. The balance comes from the NPC's AgentWallet/TBA
 * (TbaAgentWallet.balanceGcc), but Metabolism doesn't read chain itself — the
 * host injects the balance.
 */
export interface MetabolicTier {
  id: string;
  /** minimum GCC balance (display units) to qualify for this tier. */
  minBalanceGcc: number;
  /** model id this tier thinks with (host maps it to a provider; also shown in HUD). */
  model: string;
  /** short human label, e.g. "充盈" / "清醒" / "困倦". */
  label?: string;
}

export interface MetabolismConfig {
  /** tiers in any order; sorted internally by minBalanceGcc desc. */
  tiers: MetabolicTier[];
  /** strictly below this balance the NPC is "starving" → won't call the LLM. */
  starvingBelowGcc: number;
  /** tier id used when balance is unknown (null) — e.g. demo with no TBA wired. */
  defaultTierId?: string;
}

export interface MetabolicDecision {
  canThink: boolean;
  starving: boolean;
  tier: MetabolicTier;
  balanceGcc: number | null;
}

export class Metabolism {
  private readonly tiers: MetabolicTier[]; // sorted desc by minBalanceGcc
  private readonly starvingBelowGcc: number;
  private readonly defaultTier: MetabolicTier;

  constructor(config: MetabolismConfig) {
    if (!config.tiers.length) throw new Error('[Metabolism] needs at least one tier');
    this.tiers = [...config.tiers].sort((a, b) => b.minBalanceGcc - a.minBalanceGcc);
    this.starvingBelowGcc = config.starvingBelowGcc;
    this.defaultTier =
      this.tiers.find((t) => t.id === config.defaultTierId) ??
      this.tiers[this.tiers.length - 1]; // lowest tier if unspecified
  }

  /** Decide the cognitive state for a given balance. null = unknown (act normally). */
  decide(balanceGcc: number | null): MetabolicDecision {
    if (balanceGcc === null || balanceGcc === undefined || Number.isNaN(balanceGcc)) {
      return { canThink: true, starving: false, tier: this.defaultTier, balanceGcc: null };
    }
    if (balanceGcc < this.starvingBelowGcc) {
      return { canThink: false, starving: true, tier: this.tiers[this.tiers.length - 1], balanceGcc };
    }
    const tier = this.tiers.find((t) => balanceGcc >= t.minBalanceGcc) ?? this.tiers[this.tiers.length - 1];
    return { canThink: true, starving: false, tier, balanceGcc };
  }
}

/** A scripted "too drained to think" intent — emitted when an NPC is starving. */
export function hungerIntent(line?: string): AgentIntent {
  return {
    say: line ?? '（神色倦怠）……我此刻心力交瘁，容我缓一缓再与你细说。',
    effects: [],
    emotion: 'weary'
  };
}

/**
 * Default metabolism for the GCC demo. Balances are in display GCC units.
 * Unknown balance (no TBA wired) → 'sonnet' so demo NPCs act normally.
 */
export const DEFAULT_METABOLISM = new Metabolism({
  tiers: [
    { id: 'opus', minBalanceGcc: 1, model: 'claude-opus-4-8', label: '充盈' },
    { id: 'sonnet', minBalanceGcc: 0.1, model: 'claude-sonnet-4', label: '清醒' },
    { id: 'haiku', minBalanceGcc: 0.005, model: 'claude-haiku', label: '困倦' }
  ],
  starvingBelowGcc: 0.005,
  defaultTierId: 'sonnet'
});
