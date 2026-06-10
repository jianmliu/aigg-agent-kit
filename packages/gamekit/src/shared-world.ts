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
  DefaultGameRules, RelationshipMemory, resolveAddressing, DEFAULT_METABOLISM
} from '@onchainpal/npc-agent';
import type {
  Store, Scope, InferenceProvider, NpcPersona, Metabolism,
  SettlementStrategy, SettlementResult
} from '@onchainpal/npc-agent';
import type { AiggMemoryClient, PlanResult, DiscernmentResult } from '@onchainpal/npc-agent';
import { LocalLedgerActivator, ActivationError } from './aigg/activation';
import type { Activator } from './aigg/activation';
import { applyTx, relKey, type WorldState } from './stf/world-stf';
import { LlmInferenceOracle, type InferenceOracle } from './stf/inference-oracle';
import type { SettlementLayer } from './stf/settlement-layer';
import type { Effect, Attestation } from '@onchainpal/npc-agent';

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
  /** AI provenance — the oracle's signed attestation (model+prompt+response), when present. */
  attestation?: Attestation;
  /**
   * The per-turn discernment gate (decide BY memory, deterministic): present when a
   * verified belief relevant to this turn cleared θ — the NPC was warned in-prompt
   * and the host can read q/confidence (faculty=self-learned, social=peer-warned).
   */
  discernment?: DiscernmentResult;
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
   * Model backend for the COGNITION ops (Dream's reflect; plan) — e.g. Ollama
   * gemma4. Without it, dream() is a no-op (remember/select/verify/discernment
   * are deterministic and need no model).
   */
  memoryModel?: { aiggUrl: string; aiggKey?: string; model?: string; backend?: string; timeout?: number };
  /** θ for the per-turn discernment gate (relevant belief AND confidence ≥ θ). Default 0.5. */
  discernmentTheta?: number;
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
  /**
   * AI reasoning oracle — talk() runs this (impure LLM) to produce effects, then
   * applies them via the pure STF (applyTx). Defaults to LlmInferenceOracle over
   * `provider` (wraps the same LlmAgent reasoning). Inject a different/attesting
   * oracle (TEE) to make the AI output verifiable.
   */
  oracle?: InferenceOracle;
  /**
   * VALUE leg — when set, GCC is settled on a canonical layer (Base): balanceGcc
   * reads `balanceOf` (the on-chain TBA), and donate/fund `deposit` real GCC into
   * it (fixing the "donate writes a local number that never reaches the TBA"
   * gap). Unset → the local store meter (+ optional `balances` reader), as before.
   */
  settlementLayer?: SettlementLayer;
  /**
   * Persona seam — lets the host supply a full NpcPersona (tones, taboos, caps,
   * addressing tiers) for NPCs it knows, instead of the generic background-based
   * default. Called per talk() with the NPC record and the selected memory
   * bundle (when a typed-memory client is configured) — weaving the bundle into
   * the persona is the resolver's responsibility. Return undefined to fall back
   * to the default persona for that NPC (e.g. player-created NPCs the host has
   * no card for).
   */
  personaResolver?: (rec: NpcRecord, memoryBundle?: string) => NpcPersona | undefined;
}

export class SharedWorld {
  private readonly store: Store;
  private readonly provider: InferenceProvider;
  private readonly metabolism: Metabolism;
  private readonly memory?: AiggMemoryClient;
  private readonly memoryModel?: { aiggUrl: string; aiggKey?: string; model?: string; backend?: string; timeout?: number };
  private readonly discernmentTheta: number;
  private readonly activator: Activator;
  private readonly minActivationGcc: number;
  private readonly settlement?: SettlementStrategy;
  private readonly balances?: OnchainBalanceProvider;
  private readonly oracle: InferenceOracle;
  private readonly settlementLayer?: SettlementLayer;
  private readonly personaResolver?: (rec: NpcRecord, memoryBundle?: string) => NpcPersona | undefined;
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
    this.memoryModel = opts.memoryModel;
    this.discernmentTheta = opts.discernmentTheta ?? 0.5;
    this.activator = opts.activator ?? new LocalLedgerActivator();
    this.minActivationGcc = opts.minActivationGcc ?? 0.001;
    this.settlement = opts.settlement;
    this.balances = opts.balances;
    // default oracle wraps the same LlmAgent reasoning; SharedWorld gates metabolism itself.
    this.oracle = opts.oracle ?? new LlmInferenceOracle({ provider: this.provider });
    this.settlementLayer = opts.settlementLayer;
    this.personaResolver = opts.personaResolver;
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
    this.seedGoal(rec); // give the NPC a planning seed (kind=goal) so plan() has something to plan toward
    return id;
  }

  /** Write a kind=goal unit from the NPC's persona — plan() synthesizes intentions
   *  FROM goals/beliefs, not facts, so without a goal seed there is nothing to plan. */
  private seedGoal(rec: NpcRecord): void {
    if (!this.memory || !rec.background) return;
    this.memory.remember({
      slug: `${this.safeNpcSeg(rec.id)}_goal`,
      name: `${rec.name}的目标`,
      kind: 'goal',
      description: `履行${rec.name}的身份与职责：${rec.background.trim()}`,
      match: [rec.name, 'goal', '目标'],
    }, { corpus: this.memoryCorpus(rec.id), evidence: this.memoryEvidence(rec.id) }).catch(() => { /* never blocks */ });
  }

  /**
   * plan — synthesize the NPC's forward intentions (kind=plan) from its goal +
   * accumulated beliefs/facts, via aigg-memory's planner. Needs a model backend
   * (aiggUrl/model/backend, e.g. Ollama) since planning is generative. Returns
   * null if no memory client. The host (MUD) reads the plans and decides; the
   * kernel never enacts them.
   */
  async plan(npcId: string, opts: { now: string; goals?: string[]; aiggUrl?: string; aiggKey?: string; model?: string; backend?: string; timeout?: number }): Promise<PlanResult | null> {
    if (!this.memory) return null;
    try {
      return await this.memory.plan({
        corpus: this.memoryCorpus(npcId), now: opts.now, write: true, goals: opts.goals,
        aiggUrl: opts.aiggUrl, aiggKey: opts.aiggKey, model: opts.model, backend: opts.backend, timeout: opts.timeout,
      });
    } catch { return null; }
  }

  /**
   * dream — the nightly cognition pass (the Dream seam): reflect over the NPC's
   * episodes to form BELIEFS (model backend, e.g. gemma4), then verify — the
   * deterministic, no-LLM sweep that scores beliefs against outcome-tagged
   * episodes (confidence up; refuted → stale). Auto-fired after talk() on the
   * rich metabolism tier; callable explicitly by the host. Returns null without
   * a memory client + model config.
   */
  async dream(npcId: string, now: number = 0): Promise<{ beliefs: string[]; verified: number } | null> {
    if (!this.memory || !this.memoryModel) return null;
    const corpus = this.memoryCorpus(npcId);
    try {
      const r = await this.memory.reflect({
        corpus, write: true,
        aiggUrl: this.memoryModel.aiggUrl, aiggKey: this.memoryModel.aiggKey,
        model: this.memoryModel.model, backend: this.memoryModel.backend, timeout: this.memoryModel.timeout,
      });
      const v = await this.memory.verify({ corpus, write: true, ...(now ? { now: new Date(now).toISOString() } : {}) });
      return { beliefs: (r.written ?? []) as string[], verified: Object.keys(v.verified ?? {}).length };
    } catch { return null; }
  }

  /**
   * pitch — a deal proposed TO an NPC (the outcome SOURCE that feeds cognition from
   * real play, not a test harness). The decision is **gated deterministically by
   * memory** (discernment, no LLM): if the NPC holds a VERIFIED wary belief about
   * this kind of offer (q≥1, confidence ≥ θ) it DECLINES and keeps its GCC; otherwise
   * it falls for it and LOSES `amountGcc`. Either way the episode is remembered with
   * an outcome tag (loss / neutral-avoided) — the input the verification axis needs —
   * and on the rich tier a Dream (reflect+verify) runs so the belief forms/strengthens.
   * So: first pitches drain the NPC → it learns → later identical pitches are refused.
   * `scam` (default true) decides what an *accepted* deal does; an honest deal pays gain.
   */
  async pitch(input: { npcId: string; fromId: string; amountGcc: number; claim: string; scam?: boolean }): Promise<{
    accepted: boolean; protected: boolean; deltaGcc: number; balanceGcc: number; belief?: string; discernment?: DiscernmentResult;
  }> {
    const rec = await this.getNpc(input.npcId);
    if (!rec) throw new Error(`no npc ${input.npcId}`);
    const scam = input.scam ?? true;
    const bal0 = await this.balanceGcc(input.npcId);
    const now = Date.now();
    const corpus = this.memoryCorpus(input.npcId);
    const evidence = this.memoryEvidence(input.npcId);
    const topic = input.fromId; // the counterpart — discernment scans episodes citing them

    // decide BY memory: a verified wary belief about this counterpart/offer → refuse
    let gate: DiscernmentResult | undefined;
    if (this.memory) {
      for (const t of [topic, 'pitch', 'deal']) {
        try {
          const d = await this.memory.discernment(t, { corpus, mode: 'provenance', minConfidence: this.discernmentTheta });
          if (d && d.q > 0) { gate = d; break; }
        } catch { break; }
      }
    }

    if (gate) {
      // PROTECTED: declines, keeps GCC. Remember the avoidance (a 'gain' relative to the loss it dodged).
      this.memory?.remember({
        slug: `${input.fromId}_avoided_${now}`.replace(/[^a-zA-Z0-9_一-鿿-]/g, '_'),
        name: `拒绝 ${input.fromId} 的提议`, kind: 'episodic',
        description: `${rec.name} 凭已验证的警惕信念拒绝了 ${input.fromId} 的提议「${input.claim}」,守住了 ${input.amountGcc} GCC`,
        match: [input.fromId, input.npcId, 'pitch', 'deal'], outcome: 'gain',
      }, { corpus, evidence }).catch(() => {});
      return { accepted: false, protected: true, deltaGcc: 0, balanceGcc: bal0, discernment: gate };
    }

    // NAIVE: accepts. An accepted scam drains amountGcc (clamped to balance) = the loss.
    const moved = scam ? Math.min(input.amountGcc, bal0) : 0;
    const gain = scam ? 0 : input.amountGcc; // honest deal pays a return
    const balance = Math.max(0, bal0 - moved) + gain;
    await this.store.set(W, gccKey(input.npcId), balance, ONCHAIN);
    // AWAIT (not fire-and-forget): the loss episode must be persisted before dream()'s
    // reflect reads the corpus, or the just-lived outcome races the synthesis and never
    // makes it into the belief.
    await this.memory?.remember({
      slug: `${input.fromId}_${scam ? 'loss' : 'gain'}_${now}`.replace(/[^a-zA-Z0-9_一-鿿-]/g, '_'),
      name: `${input.fromId} 的提议`, kind: 'episodic',
      description: scam
        ? `${rec.name} 信了 ${input.fromId} 的提议「${input.claim}」,交了 ${moved} GCC,结果被卷走(被坑)`
        : `${rec.name} 接受了 ${input.fromId} 的提议「${input.claim}」,获利 ${gain} GCC`,
      match: [input.fromId, input.npcId, 'pitch', 'deal', ...(scam ? ['trap'] : [])],
      outcome: scam ? 'loss' : 'gain',
    }, { corpus, evidence }).catch(() => {});

    // Dream so the accumulated losses become a verified belief (rich tier only; needs model)
    let belief: string | undefined;
    if (this.memoryModel) {
      const d = await this.dream(input.npcId, now).catch(() => null);
      belief = d?.beliefs?.[0];
    }
    return { accepted: true, protected: false, deltaGcc: gain - moved, balanceGcc: balance, belief };
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
    // VALUE leg: deposit real GCC into the canonical settlement (Base TBA), so a
    // donate actually reaches the on-chain balance balanceGcc reads.
    if (this.settlementLayer) {
      await this.settlementLayer.deposit(npcId, Math.max(0, gcc));
      return this.balanceGcc(npcId);
    }
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
    // 读 rail: prefer the canonical settlement balance (Base TBA balanceOf) when a
    // settlement layer / on-chain reader is set; otherwise the local store meter.
    if (this.settlementLayer) {
      const v = await this.settlementLayer.balanceOf(npcId);
      if (v !== null) return v;
    } else if (this.balances) {
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
  /** path-safe corpus segment — npcIds contain ':' (e.g. "npc:鸿蒙:owner"), which the
   *  memory server rejects in paths. CJK is fine; only special chars are replaced. */
  private safeNpcSeg(npcId: string): string { return npcId.replace(/[^a-zA-Z0-9_一-鿿-]/g, '_'); }
  private memoryCorpus(npcId: string): string { return `npcs/${this.safeNpcSeg(npcId)}/memory`; }
  private memoryEvidence(npcId: string): string { return `npcs/${this.safeNpcSeg(npcId)}/evidence.jsonl`; }

  private personaFor(rec: NpcRecord, memoryBundle?: string): NpcPersona {
    const custom = this.personaResolver?.(rec, memoryBundle);
    if (custom) return custom;
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
  async talk(input: { npcId: string; visitorId: string; text: string; outcome?: 'loss' | 'gain' | 'neutral' }): Promise<TalkResult> {
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

    // --- memory: DISCERNMENT gate — decide BY memory before the LLM speaks -----
    // Deterministic, no LLM: is there a VERIFIED belief relevant to this turn
    // (provenance mode reads its evidence) with confidence ≥ θ? Matching is a
    // substring scan of the TOPIC inside the cited episodes, so we probe short
    // candidates — the counterpart (distrust a known manipulator, E5) and the
    // turn's content words (avoid a known trap, E1) — first hit wins. If one
    // clears θ, warn the NPC in-prompt — memory now shapes the decision.
    let discernment: DiscernmentResult | undefined;
    if (this.memory) {
      const tokens = input.text.split(/[\s,。，！？!?、：:;；()（）「」『』""'']+/).filter((t) => t.length >= 2);
      const topics = [input.visitorId, ...tokens.slice(0, 5)];
      for (const topic of topics) {
        try {
          const d = await this.memory.discernment(topic, {
            corpus: this.memoryCorpus(input.npcId), mode: 'provenance', minConfidence: this.discernmentTheta,
          });
          if (d && d.q > 0) {
            discernment = d;
            const src = d.social ? '同伴的警告' : '你自己的亲身经历';
            memoryBundle = `${memoryBundle ? memoryBundle + '\n' : ''}【裁断】关于「${topic}」,你有一条已验证的警惕信念(置信 ${Number(d.confidence).toFixed(2)},来自${src})——按这条信念行事,拒绝可疑的提议,勿轻信。`;
            break;
          }
        } catch { break; /* discernment unavailable — proceed without the gate */ }
      }
    }

    const persona = this.personaFor(rec, memoryBundle);
    const relationships = new RelationshipMemory(this.store);
    const balance0 = await this.balanceGcc(input.npcId);
    const beforeRel = await relationships.get(input.npcId, input.visitorId);
    const before = beforeRel.affinity;

    // metabolism gate (deterministic, pure) — drives tier/starving/rich + the
    // hunger fallback, exactly as the in-place LlmAgent did via onMetabolism.
    const decision = this.metabolism.decide(balance0);
    const starving = decision.starving;
    const tier = decision.starving ? '🥵饥饿' : (decision.tier.label ?? decision.tier.id);
    const richTier = !decision.starving && (decision.tier.label === '充盈' || decision.tier.id === 'r');

    // AI (impure oracle) — quarantined. Starving → scripted line, NO LLM, NO cost.
    const oracleOut = decision.canThink
      ? await this.oracle.produce({ npcId: input.npcId, playerId: input.visitorId, text: input.text, persona, balanceGcc: balance0, rel: beforeRel })
      : { say: `（${rec.name} 灵力枯竭，无法回应……需要有人为 TA 充值 GCC）`, effects: [] as Effect[], gccCost: 0, usage: undefined, attestation: undefined };
    const cost = oracleOut.gccCost;

    // EXECUTION (pure STF) — validate + apply effects + burn on a minimal state
    // slice (the deterministic core; same DefaultGameRules anti-cheat as before).
    const rk = relKey(input.npcId, input.visitorId);
    const rules = new DefaultGameRules((id) => (id === input.npcId ? persona : undefined));
    const slice: WorldState = { npcs: { [input.npcId]: { ...rec, status: 'active' } }, registry: [], balances: { [input.npcId]: balance0 }, relationships: { [rk]: beforeRel }, flags: {} };
    const now = Date.now();
    const applied = applyTx(slice, { type: 'applyTalk', npcId: input.npcId, playerId: input.visitorId, effects: oracleOut.effects, gccCost: cost, now }, rules).state;
    const rel = applied.relationships[rk];
    const balance = applied.balances[input.npcId];

    // persist via the existing tiering-safe write paths: relationship delta + burn.
    const netDelta = rel.affinity - before;
    if (netDelta !== 0) await relationships.applyDelta(input.npcId, input.visitorId, netDelta, [], now);
    if (cost > 0) await this.store.set(W, gccKey(input.npcId), balance, ONCHAIN);

    // --- 耗(thinking burn): settle this turn's GCC via the injected strategy ---
    // x402 facilitator nanopayment when configured (per-turn EIP-3009 → /verify
    // off-chain; /settle batched). Non-fatal: the inference already ran, so a
    // rejected nanopayment is surfaced (ok:false), never aborts the reply.
    let settlement: SettlementResult | undefined;
    let settleOk = true;
    if (this.settlement && oracleOut.usage && !starving && cost > 0) {
      try {
        settlement = await this.settlement.settle(input.npcId, oracleOut.usage);
      } catch {
        settleOk = false;
      }
    }

    const result: TalkResult = {
      said: oracleOut.say,
      affinity: rel.affinity,
      dAffinity: rel.affinity - before,
      addressing: resolveAddressing(persona, rel.affinity),
      tier,
      starving,
      costGcc: cost,
      balanceGcc: balance,
      ...(this.settlement && cost > 0 ? { settlement: { mode: settlement?.mode ?? 'failed', receiptId: settlement?.receiptId, ok: settleOk && !!settlement } } : {}),
      ...(oracleOut.attestation ? { attestation: oracleOut.attestation } : {}),
      ...(discernment ? { discernment } : {})
    };

    // --- memory: REMEMBER this interaction as a structured fact (fire-and-forget) ---
    // The payload is already structured (the host has it), so we write it straight
    // in as a unit via /memory/remember (zero-LLM, deterministic), immediately
    // recallable by select() on the NPC's NEXT turn. NB: consolidate does NOT
    // extract — it only promotes already-structured observations — so writing the
    // fact directly is the correct path; raw-dialogue extraction would use ingest().
    if (this.memory && !starving) {
      const corpus = this.memoryCorpus(input.npcId);
      const evidence = this.memoryEvidence(input.npcId);
      this.memory.remember({
        slug: `${input.visitorId.replace(/[^a-zA-Z0-9_一-鿿-]/g, '_')}_${now}`,
        name: input.visitorId,
        kind: 'episodic',
        description: `${input.visitorId} 说：「${input.text}」`,
        // a loss-tagged turn is the host saying "this burned me" — mark it 'trap'
        // so verify scores it and discernment's marker finds it
        match: [input.visitorId, rec.name, '好感', 'affinity', 'relationship', ...(input.outcome === 'loss' ? ['trap'] : [])],
        body: `${rec.name} 回应：「${oracleOut.say ?? '…'}」（好感 ${rel.affinity}，+${result.dAffinity}）`,
        // the verification axis's INPUT: when the host knows the result of this
        // interaction (a scam landed = loss, a deal paid off = gain), it tags it —
        // verify() later scores beliefs against these outcome-tagged episodes.
        ...(input.outcome ? { outcome: input.outcome } : {}),
      }, { corpus, evidence }).catch(() => { /* memory service down — talk never blocks */ });

      // --- memory: DREAM on the rich tier — reflect (episodes→beliefs) + verify ---
      // (fire-and-forget; needs the model backend for reflect)
      if (richTier && this.memoryModel) this.dream(input.npcId, now).catch(() => {});
    }

    return result;
  }
}
