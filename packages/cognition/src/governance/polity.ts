export type Choice = 'for' | 'against';

export interface Proposal {
  pid: string;
  proposer: string;
  ptype: string;                       // 'sanction' | host-registered types
  payload: Record<string, unknown>;
  votes: Map<string, Choice>;          // proposer pre-seeded 'for'
}

export interface TallyResult { passed: boolean; shareFor: number; effect?: Record<string, unknown> }

export type Enactor = (payload: Record<string, unknown>, polity: Polity) => Record<string, unknown>;

export interface PolityOpts { threshold?: number; enactors?: Record<string, Enactor> }

/** A pure, clock-agnostic proposal state machine: submit → cast → tally. The host
 *  decides WHEN to tally (0gtown synchronously; a tick host after a window). */
export class Polity {
  private proposals = new Map<string, Proposal>();
  private blacklist = new Map<string, number>();   // target -> until
  private seq = 0;
  private threshold: number;
  private enactors: Record<string, Enactor>;

  constructor(opts: PolityOpts = {}) {
    this.threshold = opts.threshold ?? 0.6;
    this.enactors = opts.enactors ?? {};
  }

  submit(proposer: string, ptype: string, payload: Record<string, unknown> = {}): string {
    const pid = `p${this.seq++}`;
    this.proposals.set(pid, { pid, proposer, ptype, payload, votes: new Map([[proposer, 'for']]) });
    return pid;
  }

  cast(pid: string, voter: string, choice: Choice): void {
    const pr = this.proposals.get(pid);
    if (!pr || voter === pr.proposer || pr.votes.has(voter)) return;   // no unknown/self/double vote
    pr.votes.set(voter, choice);
  }

  get(pid: string): Proposal | undefined { return this.proposals.get(pid); }

  /** shareFor = #'for' / max(1, pool.length); passed iff ≥ threshold. Enacts on pass; removes the proposal. */
  tally(pid: string, voterPool: string[]): TallyResult {
    const pr = this.proposals.get(pid);
    if (!pr) return { passed: false, shareFor: 0 };
    let fors = 0;
    for (const v of voterPool) if (pr.votes.get(v) === 'for') fors++;
    const shareFor = fors / Math.max(1, voterPool.length);
    const passed = shareFor >= this.threshold;
    const effect = passed ? this.enact(pr) : undefined;
    this.proposals.delete(pid);
    return { passed, shareFor, effect };
  }

  sanctioned(target: string, now = 0): boolean {
    return (this.blacklist.get(target) ?? -Infinity) > now;
  }

  private enact(pr: Proposal): Record<string, unknown> | undefined {
    if (pr.ptype === 'sanction') {
      const target = String(pr.payload.target);
      const until = typeof pr.payload.until === 'number' ? pr.payload.until : Infinity;
      // Math.max: a later-enacted proposal must never shorten an active blacklist (govern.py:88-93).
      this.blacklist.set(target, Math.max(this.blacklist.get(target) ?? -Infinity, until));
      return { target, until };
    }
    const fn = this.enactors[pr.ptype];
    return fn ? fn(pr.payload, this) : undefined;   // unknown ptype → no-op, never throws
  }
}
