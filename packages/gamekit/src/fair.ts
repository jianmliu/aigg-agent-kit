/**
 * FairTick — the 钱塘大集 scheduler: NPC↔NPC autonomous exchanges, one tick at
 * a time. Composes the proven SharedWorld ops; adds NO new cognition:
 *
 *   pitcher  → world.pitch(victim, fromId=pitcher)   the outcome source —
 *              the victim's decision is gated BY its memory (deterministic);
 *   gossip   → world.gossip(listener, about=pitcher)  street-talk fan-out of
 *              every loss this tick — the SOCIAL axis: listeners learn to
 *              refuse WITHOUT personal loss (E2);
 *   townsfolk  get pitched, get warned, learn.
 *
 * Zero LLM in the loop itself (pitch gate / gossip / verify are deterministic
 * memory ops) — Dream's reflect only fires inside pitch on the rich tier when
 * the world has a memoryModel. So a fair can run hundreds of ticks for free.
 *
 * Victim selection is round-robin by tick (deterministic, replayable); each
 * (gossip, scammer, listener) warning fires once (street-talk saturates).
 */
import type { SharedWorld } from './shared-world';
import type { DiscernmentResult } from '@onchainpal/npc-agent';

export interface FairActor {
  npcId: string;
  role: 'pitcher' | 'gossip' | 'townsfolk' | 'trader';
  /** pitcher: claims cycled tick by tick */
  claims?: string[];
  /** pitcher: GCC asked per pitch (default 2) */
  amountGcc?: number;
  /** trader: momentum chases the last move, contrarian fades it (default momentum) */
  style?: 'momentum' | 'contrarian';
  /** trader: 银两 (buy) / 米 (sell) committed per trade (default 1) */
  tradeAmount?: number;
}

/** an exogenous market move the host scripts (秋收 dumps rice, 风浪 buys it up) */
export interface FairShock { tick: number; npcId: string; side: 'buy' | 'sell'; amount: number; label?: string }

export interface FairPitchEvent {
  tick: number; from: string; to: string; claim: string;
  accepted: boolean; protected: boolean; deltaGcc: number;
  belief?: string; gate?: DiscernmentResult;
}
export interface FairGossipEvent { tick: number; from: string; to: string; about: string }
export interface FairTradeEvent { tick: number; npcId: string; side: 'buy' | 'sell'; amountIn: number; out: number; price: number; shock?: string }
export interface FairTickResult { tick: number; pitches: FairPitchEvent[]; gossips: FairGossipEvent[]; trades: FairTradeEvent[] }

export class FairTick {
  /** `${gossip}|${about}|${listener}` — a warning relays once */
  private readonly warned = new Set<string>();
  /** trader npcId → the price it last saw (signal source) */
  private readonly lastPrice = new Map<string, number>();

  constructor(
    private readonly world: SharedWorld,
    private readonly actors: FairActor[],
    private readonly opts: { shocks?: FairShock[] } = {}
  ) {}

  async runTick(tick: number, now = 0): Promise<FairTickResult> {
    const pitchers = this.actors.filter((a) => a.role === 'pitcher');
    const gossips = this.actors.filter((a) => a.role === 'gossip');
    const marks = this.actors.filter((a) => a.role !== 'pitcher');

    const pitches: FairPitchEvent[] = [];
    for (let i = 0; i < pitchers.length; i++) {
      const p = pitchers[i];
      if (!marks.length) break;
      const victim = marks[(tick + i) % marks.length];
      const claims = p.claims?.length ? p.claims : ['一本万利，错过再无'];
      const claim = claims[tick % claims.length];
      const r = await this.world.pitch({ npcId: victim.npcId, fromId: p.npcId, amountGcc: p.amountGcc ?? 2, claim });
      pitches.push({
        tick, from: p.npcId, to: victim.npcId, claim,
        accepted: r.accepted, protected: r.protected, deltaGcc: r.deltaGcc,
        belief: r.belief, gate: r.discernment
      });
    }

    // street talk: every loss this tick fans out as a warning to everyone else
    const gossipEvents: FairGossipEvent[] = [];
    for (const g of gossips) {
      for (const hit of pitches.filter((x) => x.accepted && x.deltaGcc < 0)) {
        const victimRec = await this.world.getNpc(hit.to);
        for (const listener of marks) {
          if (listener.npcId === hit.to || listener.npcId === g.npcId) continue;
          const key = `${g.npcId}|${hit.from}|${listener.npcId}`;
          if (this.warned.has(key)) continue;
          const ok = await this.world.gossip({
            fromNpcId: g.npcId, toNpcId: listener.npcId, about: hit.from,
            text: `听说了吗？${victimRec?.name ?? hit.to} 信了 ${hit.from} 的话，交了 ${-hit.deltaGcc} 两银子，结果被卷走了(被坑)`,
            now: now + tick
          });
          if (ok) {
            this.warned.add(key);
            gossipEvents.push({ tick, from: g.npcId, to: listener.npcId, about: hit.from });
          }
        }
      }
    }
    // exogenous shocks first (the price mover traders react to), then traders
    const trades: FairTradeEvent[] = [];
    for (const shock of (this.opts.shocks ?? []).filter((x) => x.tick === tick)) {
      const r = await this.world.tradeRice({ npcId: shock.npcId, side: shock.side, amount: shock.amount });
      if (r.ok) trades.push({ tick, npcId: shock.npcId, side: shock.side, amountIn: shock.amount, out: r.out, price: r.price!, shock: shock.label ?? 'shock' });
    }
    for (const tr of this.actors.filter((a) => a.role === 'trader')) {
      const price = await this.world.ricePrice();
      if (price == null) continue;
      const last = this.lastPrice.get(tr.npcId);
      this.lastPrice.set(tr.npcId, price);
      if (last === undefined || price === last) continue;  // first tick observes; flat = no signal
      const momentum = (tr.style ?? 'momentum') === 'momentum';
      const side: 'buy' | 'sell' = (price > last) === momentum ? 'buy' : 'sell';
      const r = await this.world.tradeRice({ npcId: tr.npcId, side, amount: tr.tradeAmount ?? 1 });
      if (r.ok) {
        trades.push({ tick, npcId: tr.npcId, side, amountIn: tr.tradeAmount ?? 1, out: r.out, price: r.price! });
        this.lastPrice.set(tr.npcId, r.price!);
      }
    }
    return { tick, pitches, gossips: gossipEvents, trades };
  }
}
