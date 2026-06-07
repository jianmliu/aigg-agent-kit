/**
 * SharedWorld — the core of the game-design toolkit: a shared, persistent world
 * populated by **user-created, user-funded AI NPCs**. Anyone can create an NPC
 * (free-text background), fund it with GCC, and place it in a public area; other
 * users discover it and talk to it; it thinks on the funded GCC (cognitive
 * metabolism), remembers each visitor, and goes dormant when the GCC runs out
 * until someone (owner or a patron) tops it up.
 *
 * STORE-AGNOSTIC: pass an InMemoryStore for a local world, or a MudStore for a
 * shared ON-CHAIN world (then every instance pointed at the same MUD World is a
 * client of the same world). All registry/persona/balance/relationship writes
 * are tagged { onchain: true } so they mirror to MUD.
 *
 * v1 scope: NPCs are stationary (驻守); placement is into public rooms; the
 * free-text background is used as the persona the runtime LLM role-plays.
 */
import {
  LlmAgent, AgentRuntime, EffectResolver, DefaultGameRules,
  RelationshipMemory, resolveAddressing, DEFAULT_METABOLISM
} from '@onchainpal/npc-agent';
import type {
  Store, Scope, InferenceProvider, NpcPersona, Actuator, StateDelta, SayOptions, Metabolism,
  SettlementStrategy, SettlementResult, InferenceUsage
} from '@onchainpal/npc-agent';
import type { AiggMemoryClient } from '@onchainpal/npc-agent';
import { LocalLedgerActivator, ActivationError } from './aigg/activation';
import type { Activator } from './aigg/activation';

const W: Scope = { type: 'world' };
const ONCHAIN = { onchain: true } as const;
const npcKey = (id: string) => `npc:${id}`;
const gccKey = (id: string) => `npc:${id}:gcc`;
const REGISTRY = 'world:npcs';

export interface NpcRecord {
  id: string;
  name: string;
  owner: string;     // user who created it
  room: string;      // public area it's stationed in
  background: string; // free text → persona role
  /**
   * Lifecycle. 'draft' = created but never funded → RAM-only, no formal record,
   * dies on restart, visible only to its owner. 'active' = funded at least once
   * → persisted, globally visible. Absent on legacy records ⇒ treated as active.
   */
  status?: 'draft' | 'active';
}
export interface NpcSummary { id: string; name: string; room: string; owner: string; balanceGcc: number; draft?: boolean }
export interface TalkResult {
  said: string | null;
  affinity: number;
  dAffinity: number;
  addressing: string;
  tier: string;
  starving: boolean;
  costGcc: number;
  balanceGcc: number;
  /**
   * Per-turn GCC settlement of the NPC's thinking via the injected
   * SettlementStrategy (x402 facilitator nanopayment when configured). `ok:false`
   * means the nanopayment was attempted but rejected/failed — the conversation
   * still proceeds (the inference already ran); the attempt is surfaced, not fatal.
   */
  settlement?: { mode: string; receiptId?: string; ok: boolean };
}

class NoopActuator implements Actuator {
  async say(_n: string, _l: string, _o?: SayOptions): Promise<void> {}
  async apply(_d: StateDelta): Promise<void> {}
}

/**
 * OnchainBalanceProvider — reads an NPC's GCC balance from its on-chain wallet
 * (ERC-6551 TBA). The "读(balance)" rail: donations land real GCC in the TBA,
 * so balanceOf(TBA) is the canonical, globally-consistent balance — any server
 * reading the chain sees the same number (a second server shows the NPC active,
 * not 沉睡). Returns null when the NPC has no on-chain wallet yet (e.g. a demo
 * NPC never minted) → SharedWorld falls back to the local store meter.
 */
export interface OnchainBalanceProvider {
  balanceGcc(npcId: string): Promise<number | null>;
}

export interface SharedWorldOptions {
  store: Store;
  provider: InferenceProvider;
  metabolism?: Metabolism;
  rooms?: string[];
  /**
   * Optional typed-memory client (agentmf serve /memory/*). When present:
   *   - talk() fires a fire-and-forget observe() after each conversation
   *   - talk() calls select() before the LLM to inject relevant semantic /
   *     episodic memory into the NPC's persona (context bundle)
   *   - talk() triggers consolidate(write:true) when the NPC's metabolism tier
   *     is "充盈" (rich) — offline Dream pass, promotes episodic→semantic
   * Without a memory client the behaviour is identical to before (no-op).
   */
  memory?: AiggMemoryClient;
  /**
   * Activation seam — invoked on a draft NPC's first GCC top-up to decide
   * whether it becomes a permanent, persisted entity. Defaults to
   * LocalLedgerActivator (records + approves, no chain). PR-B swaps in an
   * on-chain activator (mint NFT + TBA + real GCC transfer) with no other change.
   */
  activator?: Activator;
  /**
   * Minimum GCC a top-up must carry to activate a draft (anti-dust). Top-ups
   * below this leave the NPC a draft. Default 0.001.
   */
  minActivationGcc?: number;
  /**
   * Per-turn GCC settlement for the NPC's thinking. When set, talk() calls
   * settle(npcId, usage) after each inference — the "耗(thinking burn)" rail.
   * Inject X402GccEip3009Settlement (x402 facilitator nanopayment: per-turn
   * EIP-3009 sign → /verify off-chain, /settle batched) so the burn is globally
   * accounted at the shared facilitator without a tx per turn. Unset → no
   * settlement (the local balance meter is the only record, as before).
   */
  settlement?: SettlementStrategy;
  /**
   * On-chain GCC balance source (the "读" rail). When set, balanceGcc(npcId)
   * returns the NPC's TBA balanceOf() — globally consistent across servers —
   * falling back to the local store meter only when the provider returns null
   * (NPC has no on-chain wallet yet). Unset → local store meter only (demo).
   */
  balances?: OnchainBalanceProvider;
}

export class SharedWorld {
  private readonly store: Store;
  private readonly provider: InferenceProvider;
  private readonly metabolism: Metabolism;
  private readonly memory?: AiggMemoryClient;
  private readonly activator: Activator;
  private readonly minActivationGcc: number;
  private readonly settlement?: SettlementStrategy;
  private readonly balances?: OnchainBalanceProvider;
  /**
   * Draft NPCs — created but never funded. RAM-only by design: no store write,
   * so they vanish on restart and never appear in the persisted registry. Keyed
   * by npc id. Promoted to the store (and removed from here) on first funding.
   */
  private readonly draftNpcs = new Map<string, NpcRecord>();
  readonly rooms: string[];

  constructor(opts: SharedWorldOptions) {
    this.store = opts.store;
    this.provider = opts.provider;
    this.metabolism = opts.metabolism ?? DEFAULT_METABOLISM;
    this.memory = opts.memory;
    this.activator = opts.activator ?? new LocalLedgerActivator();
    this.minActivationGcc = opts.minActivationGcc ?? 0.001;
    this.settlement = opts.settlement;
    this.balances = opts.balances;
    this.rooms = opts.rooms ?? ['广场', '酒馆', '集市'];
  }

  // --- authoring -----------------------------------------------------------
  /**
   * Create + place an AI NPC from a free-text background.
   *
   * - `draft: true` (player `create`): RAM-only DRAFT — no store write, no
   *   registry entry, invisible to others, dies on restart. Becomes permanent
   *   only on its first GCC top-up (→ activate()). `startGcc` is ignored.
   * - default (platform seeding, pre-funded NPCs): persisted + active
   *   immediately, exactly as before. Backwards-compatible.
   */
  async createNpc(input: { name: string; owner: string; background: string; room?: string; startGcc?: number; id?: string; draft?: boolean }): Promise<string> {
    const id = input.id ?? `npc:${input.name}:${input.owner}`;
    const room = input.room && this.rooms.includes(input.room) ? input.room : this.rooms[0];
    if (input.draft) {
      const rec: NpcRecord = { id, name: input.name, owner: input.owner, room, background: input.background.trim(), status: 'draft' };
      this.draftNpcs.set(id, rec);
      return id;
    }
    const rec: NpcRecord = { id, name: input.name, owner: input.owner, room, background: input.background.trim(), status: 'active' };
    await this.store.set(W, npcKey(id), rec, ONCHAIN);
    await this.store.set(W, gccKey(id), input.startGcc ?? 0, ONCHAIN);
    await this.addToRegistry(id);
    return id;
  }

  /**
   * Activate a draft NPC via its first GCC top-up: run the activation seam, and
   * on success persist the record + balance + registry membership and flip it
   * to 'active'. Returns the activation result (txHash/tba when on-chain). A
   * top-up below minActivationGcc, or an activator rejection, leaves it a draft.
   */
  async activate(npcId: string, amountGcc: number, opts: { apiKey?: string } = {}) {
    const draft = this.draftNpcs.get(npcId);
    if (!draft) return { ok: false as const, reason: 'not_a_draft' };
    if (amountGcc < this.minActivationGcc) return { ok: false as const, reason: 'insufficient_gcc' };
    const res = await this.activator.activate({ npcId, owner: draft.owner, amountGcc, apiKey: opts.apiKey });
    if (!res.ok) return res;
    const rec: NpcRecord = { ...draft, status: 'active' };
    await this.store.set(W, npcKey(npcId), rec, ONCHAIN);
    await this.store.set(W, gccKey(npcId), amountGcc, ONCHAIN);
    await this.addToRegistry(npcId);
    this.draftNpcs.delete(npcId);
    return res;
  }

  /** Owner top-up (same mechanism as a patron donation). */
  async fund(npcId: string, gcc: number, opts: { apiKey?: string } = {}): Promise<number> { return this.addGccOrActivate(npcId, gcc, opts); }
  /** Anyone can sponsor an NPC's mind. First top-up of a draft activates it. */
  async donate(_donor: string, npcId: string, gcc: number, opts: { apiKey?: string } = {}): Promise<number> { return this.addGccOrActivate(npcId, gcc, opts); }

  async place(npcId: string, room: string): Promise<void> {
    if (!this.rooms.includes(room)) throw new Error(`no room ${room}`);
    const draft = this.draftNpcs.get(npcId);
    if (draft) { this.draftNpcs.set(npcId, { ...draft, room }); return; } // move stays in RAM
    const rec = await this.store.get<NpcRecord>(W, npcKey(npcId));
    if (!rec) throw new Error(`no npc ${npcId}`);
    await this.store.set(W, npcKey(npcId), { ...rec, room }, ONCHAIN);
  }

  /** Route a top-up: a draft's first qualifying top-up activates it; else add. */
  private async addGccOrActivate(npcId: string, gcc: number, opts: { apiKey?: string }): Promise<number> {
    if (this.draftNpcs.has(npcId)) {
      const res = await this.activate(npcId, gcc, opts);
      if (!res.ok) throw new ActivationError(res.reason ?? 'activation_failed');
      return this.balanceGcc(npcId);
    }
    return this.addGcc(npcId, gcc);
  }

  private async addGcc(npcId: string, gcc: number): Promise<number> {
    const bal = (await this.balanceGcc(npcId)) + Math.max(0, gcc);
    await this.store.set(W, gccKey(npcId), bal, ONCHAIN);
    return bal;
  }

  private async addToRegistry(id: string): Promise<void> {
    const reg = (await this.store.get<string[]>(W, REGISTRY)) ?? [];
    if (!reg.includes(id)) { reg.push(id); await this.store.set(W, REGISTRY, reg, ONCHAIN); }
  }

  // --- discovery -----------------------------------------------------------
  /** Resolve an NPC by id — persisted records first, then RAM drafts. */
  async getNpc(npcId: string): Promise<NpcRecord | null> {
    return (await this.store.get<NpcRecord>(W, npcKey(npcId))) ?? this.draftNpcs.get(npcId) ?? null;
  }
  async balanceGcc(npcId: string): Promise<number> {
    // 读 rail: prefer the on-chain TBA balance (globally consistent across
    // servers) when a provider is set and the NPC has an on-chain wallet;
    // otherwise fall back to the local store meter (demo / not-yet-minted).
    if (this.balances) {
      const onchain = await this.balances.balanceGcc(npcId);
      if (onchain !== null) return onchain;
    }
    return (await this.store.get<number>(W, gccKey(npcId))) ?? 0;
  }
  /**
   * List NPCs. Persisted (activated) NPCs are visible to everyone; RAM drafts
   * are visible ONLY to their owner (pass `viewerId`). No viewer → activated only.
   */
  async listNpcs(viewerId?: string): Promise<NpcSummary[]> {
    const reg = (await this.store.get<string[]>(W, REGISTRY)) ?? [];
    const out: NpcSummary[] = [];
    for (const id of reg) {
      const r = await this.getNpc(id);
      if (r) out.push({ id, name: r.name, room: r.room, owner: r.owner, balanceGcc: await this.balanceGcc(id) });
    }
    if (viewerId) {
      for (const r of this.draftNpcs.values()) {
        if (r.owner === viewerId) out.push({ id: r.id, name: r.name, room: r.room, owner: r.owner, balanceGcc: 0, draft: true });
      }
    }
    return out;
  }
  async npcsInRoom(room: string, viewerId?: string): Promise<NpcSummary[]> { return (await this.listNpcs(viewerId)).filter((n) => n.room === room); }

  // --- interaction ---------------------------------------------------------
  /**
   * corpus and evidence paths for a given NPC — used by the memory client.
   * Layout: npcs/<npcId>/memory/ + npcs/<npcId>/evidence.jsonl so every NPC
   * gets its own isolated typed-memory corpus.
   */
  private memoryCorpus(npcId: string): string { return `npcs/${npcId}/memory`; }
  private memoryEvidence(npcId: string): string { return `npcs/${npcId}/evidence.jsonl`; }

  private personaFor(rec: NpcRecord, memoryBundle?: string): NpcPersona {
    const role = [rec.background || rec.name, memoryBundle].filter(Boolean).join('\n\n');
    return {
      id: rec.id, name: rec.name,
      role,
      allowedEffects: ['adjustRelationship', 'setFlag'],
      caps: { relationshipDeltaPerTurn: 15 },
      addressing: [
        { minAffinity: 0, title: '阁下' },
        { minAffinity: 30, title: '朋友' },
        { minAffinity: 60, title: '挚友' }
      ]
    } as NpcPersona;
  }

  /** A visitor talks to a stationed NPC. The NPC thinks on its funded GCC. */
  async talk(input: { npcId: string; visitorId: string; text: string }): Promise<TalkResult> {
    const rec = await this.getNpc(input.npcId);
    if (!rec) throw new Error(`no npc ${input.npcId}`);

    // --- memory: select relevant units before LLM call (online, cheap) -------
    let memoryBundle: string | undefined;
    if (this.memory) {
      try {
        const sel = await this.memory.select(
          `${input.visitorId} ${input.text}`,
          { corpus: this.memoryCorpus(input.npcId), n_best: 4, kinds: ['semantic', 'episodic'] }
        );
        if (sel.bundle.trim()) memoryBundle = `【记忆】\n${sel.bundle.trim()}`;
      } catch { /* memory service down — degrade gracefully */ }
    }

    const persona = this.personaFor(rec, memoryBundle);
    const relationships = new RelationshipMemory(this.store);
    let balance = await this.balanceGcc(input.npcId);
    let tier = '清醒';
    let starving = false;
    let cost = 0;
    let richTier = false;
    let lastUsage: InferenceUsage | undefined;

    const agent = new LlmAgent({
      persona, provider: this.provider, relationships, metabolism: this.metabolism,
      readBalanceGcc: async () => balance,
      hungerLine: `（${rec.name} 灵力枯竭，无法回应……需要有人为 TA 充值 GCC）`,
      onMetabolism: (d) => {
        starving = d.starving;
        tier = d.starving ? '🥵饥饿' : (d.tier.label ?? d.tier.id);
        // "充盈" = labelled '充盈' or the first non-starving tier the metabolism
        // returns (highest minBalanceGcc threshold met) — rich enough for Dream.
        richTier = !d.starving && (d.tier.label === '充盈' || d.tier.id === 'r');
      },
      onUsage: (u) => { cost = u.gccCost ?? 0; balance -= cost; lastUsage = u; }
    });
    const resolver = new EffectResolver(new DefaultGameRules((id) => (id === input.npcId ? persona : undefined)));
    const runtime = new AgentRuntime({ agent, resolver, relationships, actuator: new NoopActuator(), now: () => Date.now() });

    const before = (await relationships.get(input.npcId, input.visitorId)).affinity;
    const res = await runtime.handle({ kind: 'interaction', npcId: input.npcId, playerId: input.visitorId, text: input.text } as any);
    if (cost > 0) await this.store.set(W, gccKey(input.npcId), balance, ONCHAIN); // persist the burn (local meter)

    // --- 耗(thinking burn): settle this turn's GCC via the injected strategy ---
    // x402 facilitator nanopayment when configured (per-turn EIP-3009 → /verify
    // off-chain; /settle batched). Globally accounted at the shared facilitator,
    // no tx per turn. Non-fatal: the inference already ran, so a rejected
    // nanopayment is surfaced (ok:false), never aborts the reply.
    let settlement: SettlementResult | undefined;
    let settleOk = true;
    if (this.settlement && lastUsage && !starving && cost > 0) {
      try {
        settlement = await this.settlement.settle(input.npcId, lastUsage);
      } catch {
        settleOk = false;
      }
    }

    const rel = await relationships.get(input.npcId, input.visitorId);
    const result: TalkResult = {
      said: res.said,
      affinity: rel.affinity,
      dAffinity: rel.affinity - before,
      addressing: resolveAddressing(persona, rel.affinity),
      tier,
      starving,
      costGcc: cost,
      balanceGcc: balance,
      ...(this.settlement && cost > 0 ? { settlement: { mode: settlement?.mode ?? 'failed', receiptId: settlement?.receiptId, ok: settleOk && !!settlement } } : {})
    };

    // --- memory: observe this interaction (fire-and-forget, never blocks) ----
    if (this.memory && !starving) {
      const corpus = this.memoryCorpus(input.npcId);
      const evidence = this.memoryEvidence(input.npcId);
      const obsPayload = {
        slug: input.visitorId.replace(/[^a-zA-Z0-9_一-鿿-]/g, '_'),
        name: input.visitorId,
        kind: 'episodic' as const,
        description: `${input.visitorId} 与 ${rec.name} 的互动：好感 ${rel.affinity}（+${result.dAffinity}）`,
        match: [input.visitorId, rec.name, '好感', 'affinity', 'relationship'],
        body: `「${input.text}」→ 好感 ${rel.affinity}，${rec.name} 回应：「${res.said ?? '…'}」`,
      };
      // fire-and-forget: errors are logged, never thrown
      this.memory.observe(obsPayload, { corpus, evidence }).catch(() => {});

      // --- memory: Dream consolidation when NPC is "充盈" (rich tier) --------
      if (richTier) {
        this.memory.consolidate({ corpus, evidence, write: true }).catch(() => {});
      }
    }

    return result;
  }
}
