/**
 * Activator — the seam between "a draft NPC got its first GCC top-up" and
 * "the NPC becomes a permanent, on-chain-backed entity".
 *
 * Product rule (user-decided): creating an NPC is unlimited and free, but a
 * freshly-created NPC is a DRAFT — it lives only in RAM and has NO formal
 * record, so it cannot survive a restart or be seen by other players. The
 * FIRST GCC top-up ACTIVATES it: only then is it persisted (warm tier) and,
 * eventually, anchored on-chain. This makes the economic top-up — not an
 * arbitrary count cap — the anti-spam gate.
 *
 * SharedWorld calls activate() on the first funding of a draft. The result
 * decides whether persistence proceeds. Two implementations:
 *
 *   - LocalLedgerActivator (PR-A, this file): records the activation in a local
 *     in-memory ledger and returns ok:true. No chain, no gas — ships tonight.
 *     The persistence + lifecycle + cross-restart recovery it unlocks are real.
 *
 *   - OnchainActivator (PR-B, follow-up): mints an ERC-721 for the NPC, computes
 *     its ERC-6551 TBA, transfers real GCC into the TBA, and returns the txHash
 *     + tba. Swapping it in requires ZERO changes to SharedWorld's lifecycle.
 *
 * No SECRET / API key is ever stored in the ledger — only amounts + a marker.
 */

export interface ActivationInput {
  /** the draft NPC's id. */
  npcId: string;
  /** the NPC's owner (player id) — the entity the on-chain NFT would be minted to. */
  owner: string;
  /** GCC amount of the activating top-up. */
  amountGcc: number;
  /**
   * Optional ai.gg API key of the funding player (PR-B OnchainActivator uses it
   * to drive the mint/transfer on the player's behalf). PR-A ignores it.
   * NEVER logged or persisted.
   */
  apiKey?: string;
}

export interface ActivationResult {
  /** true → SharedWorld persists the NPC and flips it to active. */
  ok: boolean;
  /** on-chain settle tx (PR-B); absent for the local activator. */
  txHash?: string;
  /** the NPC's token-bound account address (PR-B); absent for the local activator. */
  tba?: string;
  /** machine-readable failure reason when ok:false (e.g. 'insufficient_gcc'). */
  reason?: string;
}

export interface Activator {
  activate(input: ActivationInput): Promise<ActivationResult>;
}

/** Thrown when a draft top-up fails to activate (below min, or activator rejected). */
export class ActivationError extends Error {
  constructor(readonly reason: string) {
    super(`activation failed: ${reason}`);
    this.name = 'ActivationError';
  }
}

/** One ledger entry per activation — amounts + marker only, never any secret. */
export interface ActivationLedgerEntry {
  npcId: string;
  owner: string;
  amountGcc: number;
  at: number;
}

/**
 * LocalLedgerActivator — PR-A activator. Records the activation in-process and
 * approves it. Funds are tracked as the existing local GCC number (demo-grade);
 * PR-B replaces this with a real on-chain mint + TBA transfer.
 */
export class LocalLedgerActivator implements Activator {
  /** in-memory activation log — inspectable by tests; holds NO secrets. */
  readonly ledger: ActivationLedgerEntry[] = [];
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  async activate(input: ActivationInput): Promise<ActivationResult> {
    this.ledger.push({
      npcId: input.npcId,
      owner: input.owner,
      amountGcc: input.amountGcc,
      at: this.now(),
    });
    return { ok: true };
  }
}
