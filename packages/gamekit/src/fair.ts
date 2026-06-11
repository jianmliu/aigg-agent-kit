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
 * SPATIAL (信息跟着身体走): every interaction is gated by CO-LOCATION — a
 * pitcher works only the marks in HIS room, a gossip can only relay losses
 * she WITNESSED (same room) and only to listeners beside her. Cross-room
 * spread therefore requires movement: actors with a `route` patrol it
 * (deterministic schedule — the Smallville daily-routine layer; LLM plans
 * arrive later via the PlanExecutor). Rooms are read LIVE from the world.
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
  /** fallback room when the actor has no NPC record (e.g. a virtual pitcher) */
  room?: string;
  /** patrol stops — the actor moves along this cycle (schedule layer) */
  route?: string[];
  /** ticks spent at each stop (default 3) */
  dwell?: number;
}

/** an exogenous market move the host scripts (秋收 dumps rice, 风浪 buys it up) */
export interface FairShock { tick: number; npcId: string; side: 'buy' | 'sell'; amount: number; label?: string }

export interface FairPitchEvent {
  tick: number; from: string; to: string; claim: string; room: string;
  accepted: boolean; protected: boolean; deltaGcc: number;
  belief?: string; gate?: DiscernmentResult;
}
export interface FairGossipEvent { tick: number; from: string; to: string; about: string; room: string }
export interface FairTradeEvent { tick: number; npcId: string; side: 'buy' | 'sell'; amountIn: number; out: number; price: number; shock?: string }
export interface FairMoveEvent { tick: number; npcId: string; from: string; to: string }
export interface FairTickResult { tick: number; moves: FairMoveEvent[]; pitches: FairPitchEvent[]; gossips: FairGossipEvent[]; trades: FairTradeEvent[] }

export class FairTick {
  /** `${gossip}|${about}|${listener}` — a warning relays once */
  private readonly warned = new Set<string>();
  /** trader npcId → the price it last saw (signal source) */
  private readonly lastPrice = new Map<string, number>();

  constructor(
    private readonly world: SharedWorld,
    private readonly actors: FairActor[],
    private readonly opts: {
      shocks?: FairShock[];
      /** when set, traders/shocks must be IN this room (the granary's) */
      marketRoom?: string;
    } = {}
  ) {}

  /** the actor's CURRENT room — the live world record, else the static fallback. */
  private async roomOf(a: FairActor): Promise<string> {
    return (await this.world.getNpc(a.npcId))?.room ?? a.room ?? '';
  }

  async runTick(tick: number, now = 0): Promise<FairTickResult> {
    const pitchers = this.actors.filter((a) => a.role === 'pitcher');
    const gossips = this.actors.filter((a) => a.role === 'gossip');
    const marks = this.actors.filter((a) => a.role !== 'pitcher');

    // movement first (the schedule layer): patrol actors step to this tick's stop
    const moves: FairMoveEvent[] = [];
    for (const a of this.actors) {
      if (!a.route?.length) continue;
      const target = a.route[Math.floor(tick / (a.dwell ?? 3)) % a.route.length];
      const from = await this.roomOf(a);
      if (from === target) continue;
      try {
        await this.world.place(a.npcId, target);
        moves.push({ tick, npcId: a.npcId, from, to: target });
      } catch { /* no record to move — stays put */ }
    }

    // live rooms AFTER movement — co-location gates everything below
    const rooms = new Map<string, string>();
    for (const a of this.actors) rooms.set(a.npcId, await this.roomOf(a));

    const pitches: FairPitchEvent[] = [];
    for (let i = 0; i < pitchers.length; i++) {
      const p = pitchers[i];
      const here = rooms.get(p.npcId) ?? '';
      const inRoom = marks.filter((m) => rooms.get(m.npcId) === here && here !== '');
      if (!inRoom.length) continue;                       // nobody to work — go where the marks are
      const victim = inRoom[(tick + i) % inRoom.length];
      const claims = p.claims?.length ? p.claims : ['一本万利，错过再无'];
      const claim = claims[tick % claims.length];
      const r = await this.world.pitch({ npcId: victim.npcId, fromId: p.npcId, amountGcc: p.amountGcc ?? 2, claim });
      pitches.push({
        tick, from: p.npcId, to: victim.npcId, claim, room: here,
        accepted: r.accepted, protected: r.protected, deltaGcc: r.deltaGcc,
        belief: r.belief, gate: r.discernment
      });
    }

    // street talk: a gossip relays only losses she WITNESSED (same room), and
    // only to listeners beside her — information travels with bodies.
    const gossipEvents: FairGossipEvent[] = [];
    for (const g of gossips) {
      const here = rooms.get(g.npcId) ?? '';
      if (!here) continue;
      for (const hit of pitches.filter((x) => x.accepted && x.deltaGcc < 0 && x.room === here)) {
        const victimRec = await this.world.getNpc(hit.to);
        for (const listener of marks) {
          if (listener.npcId === hit.to || listener.npcId === g.npcId) continue;
          if (rooms.get(listener.npcId) !== here) continue;
          const key = `${g.npcId}|${hit.from}|${listener.npcId}`;
          if (this.warned.has(key)) continue;
          const ok = await this.world.gossip({
            fromNpcId: g.npcId, toNpcId: listener.npcId, about: hit.from,
            text: `听说了吗？${victimRec?.name ?? hit.to} 信了 ${hit.from} 的话，交了 ${-hit.deltaGcc} 两银子，结果被卷走了(被坑)`,
            now: now + tick
          });
          if (ok) {
            this.warned.add(key);
            gossipEvents.push({ tick, from: g.npcId, to: listener.npcId, about: hit.from, room: here });
          }
        }
      }
    }
    // exogenous shocks first (the price mover traders react to), then traders.
    // With a marketRoom set, trading requires being AT the granary.
    const atMarket = (id: string) => !this.opts.marketRoom || rooms.get(id) === this.opts.marketRoom;
    const trades: FairTradeEvent[] = [];
    for (const shock of (this.opts.shocks ?? []).filter((x) => x.tick === tick)) {
      // a shock's mover may not be a fair actor — resolve its room from the world
      const shockRoom = rooms.get(shock.npcId) ?? (await this.world.getNpc(shock.npcId))?.room ?? '';
      if (this.opts.marketRoom && shockRoom !== this.opts.marketRoom) continue;
      const r = await this.world.tradeRice({ npcId: shock.npcId, side: shock.side, amount: shock.amount });
      if (r.ok) trades.push({ tick, npcId: shock.npcId, side: shock.side, amountIn: shock.amount, out: r.out, price: r.price!, shock: shock.label ?? 'shock' });
    }
    for (const tr of this.actors.filter((a) => a.role === 'trader')) {
      if (!atMarket(tr.npcId)) continue;
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
    return { tick, moves, pitches, gossips: gossipEvents, trades };
  }
}
