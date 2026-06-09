/**
 * world-stf — the MUD world as a DETERMINISTIC state-transition function.
 *
 * This is the substrate-agnostic core for running the world as a sequencer /
 * Autonomys Domain / app-rollup: a pure `applyTx(state, tx)` with NO I/O, NO
 * clock, NO LLM, NO randomness — so any operator can re-execute it and a
 * fraud-proof can challenge a wrong receipt. The non-deterministic AI reasoning
 * lives entirely OUTSIDE (see inference-oracle.ts): the oracle produces effects
 * (a signed `applyTalk` tx input); the STF only deterministically APPLIES them.
 *
 * Reuses the kit's existing pure pieces — `Effect`, `DefaultGameRules.validate`
 * (anti-cheat/capping), `RelationshipState`. Nothing new is invented; this just
 * extracts the boundary the codebase was already designed around
 * (AgentRuntime: "offchain-reasoning / deterministic-mutation boundary").
 */
import { createHash } from 'node:crypto';
import type { Effect, GameRules, RuleContext, RelationshipState } from '@onchainpal/npc-agent';
import type { NpcRecord } from '../shared-world';

/** A persisted NPC in world state — identity + lifecycle status. */
export type StfNpc = NpcRecord & { status: 'draft' | 'active' };

/** The full, plain-serializable world state (domain-native; GCC is a native balance). */
export interface WorldState {
  npcs: Record<string, StfNpc>;
  /** activated NPC ids, globally visible (= world:npcs registry). */
  registry: string[];
  /** npcId → GCC balance (domain-native; in the live Base build this maps to the TBA). */
  balances: Record<string, number>;
  /** `${npcId}|${playerId}` → per-visitor relationship. */
  relationships: Record<string, RelationshipState>;
  /** `${playerId}|${flag}` → value. */
  flags: Record<string, number>;
  /** per-agent USDC balance (pump-town economy; absent in pure-MUD worlds). */
  usdc?: Record<string, number>;
  /** the constant-product AMM pool (pump-town; absent until `initMarket`). */
  market?: MarketState;
}

/** pump-town's constant-product AMM pool. Spot price p_t = usdcReserve/gccReserve (USDC per GCC). */
export interface MarketState { gccReserve: number; usdcReserve: number; supply: number }

/** Deterministic transactions — the committed state transitions (mirror SharedWorld ops). */
export type WorldTx =
  | { type: 'createNpc'; id: string; name: string; owner: string; room: string; background: string; draft?: boolean }
  | { type: 'activate'; npcId: string; amountGcc: number }
  | { type: 'donate'; npcId: string; amountGcc: number }
  | { type: 'move'; npcId: string; room: string }
  /** the committed result of a talk: the oracle's effects + GCC cost. `now` is
   *  carried IN the tx (never read from the clock) so execution is reproducible. */
  | { type: 'applyTalk'; npcId: string; playerId: string; effects: Effect[]; gccCost: number; now: number }
  /**
   * An EXOGENOUS luck shock (Talent-vs-Luck experiment). The randomness lives in
   * the seeded stream that GENERATES these txs (outside the STF); the STF only
   * applies them deterministically, so the whole run replays bit-for-bit.
   * `gccFactor` = multiplicative luck (balance *= f, e.g. 1.5 good / 0.5 bad);
   * `gccDelta` = additive luck (balance += d, d<0 = bad). Both optional/composable.
   */
  | { type: 'luckEvent'; npcId: string; gccDelta?: number; gccFactor?: number; affinityDelta?: number; playerId?: string; label?: string; now: number }
  // ── pump-town economic core (the high-stake, on-chain-executed subset) ──────
  /** Seed the constant-product AMM pool + initial GCC supply (genesis-ish). */
  | { type: 'initMarket'; gccReserve: number; usdcReserve: number; supply?: number }
  /** An AMM swap by an agent — pump-town's CHEATABLE core (deterministic pricing,
   *  no fake fills / no front-run beyond tx order). buy: `amountIn` USDC → GCC out;
   *  sell: `amountIn` GCC → USDC out. */
  | { type: 'trade'; agentId: string; side: 'buy' | 'sell'; amountIn: number; now: number }
  /** Pay `perGcc` USDC to every GCC holder (the v_t value anchor / income distribution). */
  | { type: 'dividend'; perGcc: number };

/** Events emitted by a tx — the receipt/log (also fraud-proof comparable). */
export type WorldEvent =
  | { kind: 'npcCreated'; npcId: string; status: 'draft' | 'active' }
  | { kind: 'activated'; npcId: string; balanceGcc: number }
  | { kind: 'donated'; npcId: string; balanceGcc: number }
  | { kind: 'moved'; npcId: string; room: string }
  | { kind: 'affinityChanged'; npcId: string; playerId: string; delta: number; affinity: number }
  | { kind: 'flagSet'; playerId: string; flag: string; value: number }
  | { kind: 'hostEffect'; npcId: string; playerId: string; effect: Effect }
  | { kind: 'burned'; npcId: string; gccCost: number; balanceGcc: number }
  /** an exogenous luck shock; `gccAfter - gccBefore` IS the realized luck score (exact, auditable). */
  | { kind: 'luck'; npcId: string; label?: string; gccBefore: number; gccAfter: number }
  | { kind: 'marketInit'; gccReserve: number; usdcReserve: number; supply: number }
  | { kind: 'traded'; agentId: string; side: 'buy' | 'sell'; amountIn: number; out: number; price: number; gccReserve: number; usdcReserve: number }
  | { kind: 'dividend'; perGcc: number; totalPaid: number }
  | { kind: 'rejected'; reason: string; tx?: WorldTx; effect?: Effect };

export const relKey = (npcId: string, playerId: string) => `${npcId}|${playerId}`;

/**
 * Constant-product AMM (x·y=k). PURE. `side:'buy'` spends `amountIn` USDC for GCC out;
 * `side:'sell'` puts `amountIn` GCC in for USDC out. No fee in this first cut.
 * NB: float math here is the REFERENCE implementation; a Solidity `PumpWorld` port
 * uses fixed-point and the differential test must reconcile rounding.
 */
export function ammSwap(m: MarketState, side: 'buy' | 'sell', amountIn: number): { out: number; price: number; gccReserve: number; usdcReserve: number } {
  const k = m.gccReserve * m.usdcReserve;
  if (side === 'buy') {
    const usdcReserve = m.usdcReserve + amountIn;
    const gccReserve = k / usdcReserve;
    return { out: m.gccReserve - gccReserve, price: usdcReserve / gccReserve, gccReserve, usdcReserve };
  }
  const gccReserve = m.gccReserve + amountIn;
  const usdcReserve = k / gccReserve;
  return { out: m.usdcReserve - usdcReserve, price: usdcReserve / gccReserve, gccReserve, usdcReserve };
}

export function emptyWorld(): WorldState {
  return { npcs: {}, registry: [], balances: {}, relationships: {}, flags: {} };
}

/**
 * The state-transition function. PURE: returns a NEW state (input untouched),
 * uses only the tx + injected GameRules, no I/O / clock / RNG / LLM.
 */
export function applyTx(prev: WorldState, tx: WorldTx, rules: GameRules): { state: WorldState; events: WorldEvent[] } {
  const state = structuredClone(prev);
  const events: WorldEvent[] = [];

  switch (tx.type) {
    case 'createNpc': {
      const status: 'draft' | 'active' = tx.draft ? 'draft' : 'active';
      state.npcs[tx.id] = { id: tx.id, name: tx.name, owner: tx.owner, room: tx.room, background: tx.background.trim(), status };
      if (status === 'active') {
        if (!state.registry.includes(tx.id)) state.registry.push(tx.id);
        state.balances[tx.id] ??= 0;
      }
      events.push({ kind: 'npcCreated', npcId: tx.id, status });
      break;
    }
    case 'activate': {
      const npc = state.npcs[tx.npcId];
      if (!npc) { events.push({ kind: 'rejected', reason: 'no_npc', tx }); break; }
      npc.status = 'active';
      state.balances[tx.npcId] = tx.amountGcc;
      if (!state.registry.includes(tx.npcId)) state.registry.push(tx.npcId);
      events.push({ kind: 'activated', npcId: tx.npcId, balanceGcc: tx.amountGcc });
      break;
    }
    case 'donate': {
      if (!state.npcs[tx.npcId]) { events.push({ kind: 'rejected', reason: 'no_npc', tx }); break; }
      state.balances[tx.npcId] = (state.balances[tx.npcId] ?? 0) + Math.max(0, tx.amountGcc);
      events.push({ kind: 'donated', npcId: tx.npcId, balanceGcc: state.balances[tx.npcId] });
      break;
    }
    case 'move': {
      const npc = state.npcs[tx.npcId];
      if (!npc) { events.push({ kind: 'rejected', reason: 'no_npc', tx }); break; }
      npc.room = tx.room;
      events.push({ kind: 'moved', npcId: tx.npcId, room: tx.room });
      break;
    }
    case 'applyTalk': {
      const ctx: RuleContext = { npcId: tx.npcId, playerId: tx.playerId };
      for (const effect of tx.effects) {
        const verdict = rules.validate(effect, ctx); // reuse DefaultGameRules anti-cheat/cap
        if (!verdict.ok) { events.push({ kind: 'rejected', reason: verdict.reason, effect }); continue; }
        if (effect.kind === 'adjustRelationship') {
          const key = relKey(tx.npcId, tx.playerId);
          const rel = state.relationships[key] ?? { affinity: 0, tags: [] };
          const tags = effect.reason ? rel.tags : rel.tags; // (reason kept on the effect/log, not a tag here)
          state.relationships[key] = { ...rel, tags, affinity: rel.affinity + effect.delta, lastInteractionAt: tx.now };
          events.push({ kind: 'affinityChanged', npcId: tx.npcId, playerId: tx.playerId, delta: effect.delta, affinity: state.relationships[key].affinity });
        } else if (effect.kind === 'setFlag') {
          state.flags[`${tx.playerId}|${effect.flag}`] = effect.value;
          events.push({ kind: 'flagSet', playerId: tx.playerId, flag: effect.flag, value: effect.value });
        } else {
          // giveItem/takeItem/quests — host-delegated; recorded as an event for the host to enact.
          events.push({ kind: 'hostEffect', npcId: tx.npcId, playerId: tx.playerId, effect });
        }
      }
      if (tx.gccCost > 0) {
        const b = state.balances[tx.npcId] ?? 0;
        state.balances[tx.npcId] = Math.max(0, b - tx.gccCost); // 耗: deterministic burn
        events.push({ kind: 'burned', npcId: tx.npcId, gccCost: tx.gccCost, balanceGcc: state.balances[tx.npcId] });
      }
      break;
    }
    case 'luckEvent': {
      if (!state.npcs[tx.npcId]) { events.push({ kind: 'rejected', reason: 'no_npc', tx }); break; }
      const before = state.balances[tx.npcId] ?? 0;
      let after = before;
      if (tx.gccFactor != null) after = after * tx.gccFactor;   // multiplicative luck
      if (tx.gccDelta != null) after = after + tx.gccDelta;      // additive luck (delta<0 = bad)
      after = Math.max(0, after);
      state.balances[tx.npcId] = after;
      if (tx.affinityDelta != null && tx.playerId) {
        const key = relKey(tx.npcId, tx.playerId);
        const rel = state.relationships[key] ?? { affinity: 0, tags: [] };
        state.relationships[key] = { ...rel, affinity: rel.affinity + tx.affinityDelta, lastInteractionAt: tx.now };
      }
      events.push({ kind: 'luck', npcId: tx.npcId, label: tx.label, gccBefore: before, gccAfter: after });
      break;
    }
    case 'initMarket': {
      state.market = { gccReserve: tx.gccReserve, usdcReserve: tx.usdcReserve, supply: tx.supply ?? 0 };
      events.push({ kind: 'marketInit', gccReserve: tx.gccReserve, usdcReserve: tx.usdcReserve, supply: state.market.supply });
      break;
    }
    case 'trade': {
      if (!state.market) { events.push({ kind: 'rejected', reason: 'no_market', tx }); break; }
      if (!(tx.amountIn > 0)) { events.push({ kind: 'rejected', reason: 'bad_amount', tx }); break; }
      state.usdc ??= {};
      const usdcBal = state.usdc[tx.agentId] ?? 0;
      const gccBal = state.balances[tx.agentId] ?? 0;
      if (tx.side === 'buy' && usdcBal < tx.amountIn) { events.push({ kind: 'rejected', reason: 'insufficient_usdc', tx }); break; }
      if (tx.side === 'sell' && gccBal < tx.amountIn) { events.push({ kind: 'rejected', reason: 'insufficient_gcc', tx }); break; }
      const sw = ammSwap(state.market, tx.side, tx.amountIn);
      state.market.gccReserve = sw.gccReserve;
      state.market.usdcReserve = sw.usdcReserve;
      if (tx.side === 'buy') {
        state.usdc[tx.agentId] = usdcBal - tx.amountIn;       // USDC moves agent → reserve
        state.balances[tx.agentId] = gccBal + sw.out;          // GCC moves reserve → agent
      } else {
        state.balances[tx.agentId] = gccBal - tx.amountIn;
        state.usdc[tx.agentId] = usdcBal + sw.out;
      }
      events.push({ kind: 'traded', agentId: tx.agentId, side: tx.side, amountIn: tx.amountIn, out: sw.out, price: sw.price, gccReserve: sw.gccReserve, usdcReserve: sw.usdcReserve });
      break;
    }
    case 'dividend': {
      state.usdc ??= {};
      let totalPaid = 0;
      for (const id of Object.keys(state.balances)) {
        const g = state.balances[id] ?? 0;
        if (g <= 0) continue;
        const pay = g * tx.perGcc;
        state.usdc[id] = (state.usdc[id] ?? 0) + pay;
        totalPaid += pay;
      }
      events.push({ kind: 'dividend', perGcc: tx.perGcc, totalPaid });
      break;
    }
  }
  return { state, events };
}

/** Replay a sequence of txs from a state — deterministic by construction. */
export function applyAll(prev: WorldState, txs: WorldTx[], rules: GameRules): { state: WorldState; events: WorldEvent[] } {
  let state = prev;
  const events: WorldEvent[] = [];
  for (const tx of txs) {
    const r = applyTx(state, tx, rules);
    state = r.state;
    events.push(...r.events);
  }
  return { state, events };
}

/** Canonical (key-sorted) serialization → a reproducible state root (fraud-proof anchor). */
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
}
export function stateRoot(state: WorldState): string {
  return createHash('sha256').update(canonical(state), 'utf8').digest('hex');
}
