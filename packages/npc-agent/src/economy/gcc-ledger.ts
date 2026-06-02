import type { Store, Scope } from '../store/store';
import type { InferenceUsage } from '../inference/provider';

/**
 * GccLedger — a per-NPC **virtual GCC sub-ledger**.
 *
 * Demo funding model (2026-06): the game is ONE AIGG user — a single funding EOA
 * holds GCC and a scoped agent EOA signs the x402/Permit2 payments (that lives in
 * the AIGG backend; onchainpal doesn't sign on-chain). What onchainpal owns is the
 * *accounting*: how much GCC each NPC's thinking consumed. This ledger accumulates
 * `usage.gccCost` per NPC from every inference, persisted via the Store.
 *
 * Entries are written with `{ onchain: true }` — the GCC-consumption record is the
 * thing that conceptually settles; when per-NPC wallets / real settlement arrive,
 * this ledger is the bridge.
 */
export interface GccLedgerEntry {
  gccSpent: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  lastAt?: number;
}

const ZERO: GccLedgerEntry = { gccSpent: 0, calls: 0, inputTokens: 0, outputTokens: 0 };
const ledgerScope: Scope = { type: 'world' };
const key = (npcId: string) => `gcc-ledger:${npcId}`;

export class GccLedger {
  constructor(
    private readonly store: Store,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** add one inference's usage to the NPC's running total; returns the new total. */
  async record(npcId: string, usage: InferenceUsage): Promise<GccLedgerEntry> {
    const cur = (await this.store.get<GccLedgerEntry>(ledgerScope, key(npcId))) ?? ZERO;
    const next: GccLedgerEntry = {
      gccSpent: cur.gccSpent + (usage.gccCost ?? 0),
      calls: cur.calls + 1,
      inputTokens: cur.inputTokens + (usage.inputTokens ?? 0),
      outputTokens: cur.outputTokens + (usage.outputTokens ?? 0),
      lastAt: this.now()
    };
    await this.store.set(ledgerScope, key(npcId), next, { onchain: true });
    return next;
  }

  async get(npcId: string): Promise<GccLedgerEntry> {
    return (await this.store.get<GccLedgerEntry>(ledgerScope, key(npcId))) ?? { ...ZERO };
  }
}
