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
import { applyTx, relKey, type WorldState, type WorldEvent, type WorldTx, type MarketState, type PredictionMarket } from './stf/world-stf';
import { LlmInferenceOracle, type InferenceOracle } from './stf/inference-oracle';
import type { SettlementLayer } from './stf/settlement-layer';
import type { Effect, Attestation } from '@onchainpal/npc-agent';
import {
  decayNeeds, satisfy, summarizeNeeds, urgent, DEFAULT_NEEDS_CONFIG,
  type NeedsState, type NeedsConfig
} from '@onchainpal/npc-agent';

const W: Scope = { type: 'world' };
const ONCHAIN = { onchain: true } as const;
const npcKey = (id: string) => `npc:${id}`;
const gccKey = (id: string) => `npc:${id}:gcc`;
const silverKey = (id: string) => `npc:${id}:silver`;   // off-chain 游戏货币(银两)账,与 gcc 并列但不带 ONCHAIN
const diaryKey = (id: string) => `npc:${id}:diary`;   // off-chain 夜记 log (narrative, not a typed memory unit)
const logKey = (id: string) => `npc:${id}:log`;       // off-chain 3rd-person system log (debug: say/move/pitch/dream)
const riceKey = (id: string) => `npc:${id}:rice`;
const needsKey = (id: string) => `npc:${id}:needs`;   // off-chain 易变态(同 diary/log,不带 ONCHAIN)
const RICE_MARKET = 'world:market:rice';
const RICE_BETS = 'world:market:bets';
const REGISTRY = 'world:npcs';
/** index of relationship keys ever written (`npcId|playerId`) — lets
 *  snapshotState() enumerate relationships from a list-less Store. */
const REL_INDEX = 'world:rels';

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
export interface NpcSummary { id: string; name: string; room: string; owner: string; balanceGcc: number; balanceSilver: number; draft?: boolean }
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
  /** corpus namespace — prefixes every NPC's memory path (e.g. 'pal' →
   *  pal/npcs/<id>/memory) so worlds sharing one agentmf serve stay isolated.
   *  Default '' (npcs/<id>/memory, unchanged). */
  memoryNamespace?: string;
  /** θ for the per-turn discernment gate (relevant belief AND confidence ≥ θ). Default 0.5. */
  discernmentTheta?: number;
  /** 好感门槛:非 sudo/owner 的访客要「说动」NPC 移动(goto)所需的 affinity。
   *  Ford 原则——游客没有直接命令权,只有记忆与好感两条影响通道。Default 30. */
  commandAffinity?: number;
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
   * Tick/DA seam — receives every WorldEvent the world produces, in order:
   * the STF events of each applied tx (affinityChanged/flagSet/burned/…) plus
   * the narrative events SharedWorld synthesizes around them (`say` — the
   * oracle's line, which the pure STF never sees) and the lifecycle events of
   * the non-STF write paths (npcCreated/activated/donated/moved). A host
   * accumulates these per tick and hands them to TickCommitter together with
   * snapshotState(). Fire-and-forget: a throwing handler never breaks a talk.
   * NOTE: flagSet effects are NOT persisted by SharedWorld (the flags slice is
   * per-turn) — the event stream is their only durable record.
   */
  onEvents?: (events: WorldEvent[], ctx: { now: number; tx?: WorldTx }) => void;
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
  /** 需求多轴配置(轴/衰减率/阈值/房间满足表)——host 从 WorldDef.needs 注入;无则 DEFAULT_NEEDS_CONFIG。 */
  needs?: NeedsConfig;
  /**
   * 单向兑换桥配置(银两 → GCC)——host 从 WorldDef.economy.exchange 注入。
   * enabled:开关(默认关,保守);rate:每 1 GCC 需多少银两;dailyCapSilver:每日可兑换银两上限。
   * 未注入 → 桥默认关闭(exchangeSilverForGcc 直接 reason:'exchange_disabled')。
   */
  exchange?: { enabled: boolean; rate: number; dailyCapSilver: number };
  /**
   * ②层 store key 的世界前缀(= WorldDef.id)。所有「世界本地层」key(市场/赌坊/
   * 银两/米/需求/exchange:day/registry/rels/diary/log)经 wkey() 包成 `w:<worldId>:…`,
   * 世界间互不可见、互不撞库(economy-multiverse spec §2)。默认 'pal' —— 与旧裸 key
   * 兼容:worldId==='pal' 时对②层读做一次性惰性迁移(裸有值且 scoped 缺 → 搬运,见 getScoped)。
   * ①层(GCC/tokenId/card/npc record)永不上前缀,随魂走、留全局命名空间。
   */
  worldId?: string;
  /** 世界默认回话语言('zh' 默认 | 'en')→ 注入 NPC 的 say 输出语言;玩家可经 talk(lang) 覆盖。 */
  language?: 'zh' | 'en';
  /**
   * 旁听(overhearing)—— 同房间其他 NPC 能听见一段说出口的对话并形成 episodic 记忆,
   * 富裕(rich tier)NPC 经 metabolism 门控可低概率插话,穷/饥饿 NPC 只记不说。
   * 目标:涌现性声誉/八卦传播(郎中当面行骗 → 旁听者亲历级警惕信念)。
   * 设计依据 docs/specs/emergence-world-notes.md §3(对标 Emergence HEARING_DISTANCE=25,≤4 旁听者)。
   * 全可选、确定性(无概率字段——确定性铁律禁随机源)。未注入 → kit 默认安全值:
   *   enabled=true(记忆扩散默认开,remember 零成本)
   *   maxListeners=4(成本封顶:即便满房富 NPC,旁听处理 ≤4 个 → remember ≤4 次)
   *   interject=true 但受 rich 门控 + interjectMaxPerTalk=1 双重封顶(默认富者至多 1 次插话)
   *   interjectMaxPerTalk=1(每次 talk 至多 1 次插话 → 至多 1 次额外推理/GCC 烧)
   */
  overhear?: { enabled?: boolean; maxListeners?: number; interject?: boolean; interjectMaxPerTalk?: number };
}

export class SharedWorld {
  private readonly store: Store;
  private readonly provider: InferenceProvider;
  private readonly metabolism: Metabolism;
  private readonly memory?: AiggMemoryClient;
  private readonly memoryModel?: { aiggUrl: string; aiggKey?: string; model?: string; backend?: string; timeout?: number };
  private readonly memoryNs: string = '';
  private readonly discernmentTheta: number;
  private readonly commandAffinity: number;
  private readonly activator: Activator;
  private readonly minActivationGcc: number;
  private readonly settlement?: SettlementStrategy;
  private readonly balances?: OnchainBalanceProvider;
  private readonly oracle: InferenceOracle;
  private readonly settlementLayer?: SettlementLayer;
  private readonly personaResolver?: (rec: NpcRecord, memoryBundle?: string) => NpcPersona | undefined;
  private readonly needsCfg: NeedsConfig;
  /** 兑换桥配置(单向 银两→GCC)——未注入 → 默认关闭、保守汇率。 */
  private readonly exchangeCfg: { enabled: boolean; rate: number; dailyCapSilver: number };
  /** ②层 key 的世界前缀(= WorldDef.id);默认 'pal'(旧裸 key 兼容 + 惰性迁移触发)。 */
  private readonly worldId: string;
  private readonly language?: 'zh' | 'en';
  /** 旁听配置 —— 全字段已落默认(见构造函数)。成本封顶双闸:maxListeners≤4 / interjectMaxPerTalk≤1。 */
  private readonly overhearCfg: { enabled: boolean; maxListeners: number; interject: boolean; interjectMaxPerTalk: number };
  private readonly onEvents?: (events: WorldEvent[], ctx: { now: number; tx?: WorldTx }) => void;
  /**
   * Draft NPCs — created but never funded. RAM-only by design: no store write,
   * so they vanish on restart and never appear in the persisted registry. Keyed
   * by npc id. Promoted to the store (and removed from here) on first funding.
   */
  private readonly draftNpcs = new Map<string, NpcRecord>();
  /**
   * goto inbox — movement directives an NPC has been GIVEN this turn (a `goto`
   * effect from talk, e.g. the player telling 香兰「去客栈」). In-process, RAM
   * only: the same SharedWorld instance hosts both talk() (writer) and the
   * per-NPC PlanExecutor (reader, drains it each tick). Keyed by npc id.
   */
  private readonly gotoInbox = new Map<string, string[]>();
  readonly rooms: string[];

  constructor(opts: SharedWorldOptions) {
    this.store = opts.store;
    this.provider = opts.provider;
    this.metabolism = opts.metabolism ?? DEFAULT_METABOLISM;
    this.memory = opts.memory;
    this.memoryModel = opts.memoryModel;
    this.memoryNs = opts.memoryNamespace ? `${opts.memoryNamespace.replace(/\/+$/, '')}/` : '';
    this.discernmentTheta = opts.discernmentTheta ?? 0.5;
    this.commandAffinity = opts.commandAffinity ?? 30;
    this.activator = opts.activator ?? new LocalLedgerActivator();
    this.minActivationGcc = opts.minActivationGcc ?? 0.001;
    this.settlement = opts.settlement;
    this.balances = opts.balances;
    // default oracle wraps the same LlmAgent reasoning; SharedWorld gates metabolism itself.
    this.oracle = opts.oracle ?? new LlmInferenceOracle({ provider: this.provider });
    this.settlementLayer = opts.settlementLayer;
    this.personaResolver = opts.personaResolver;
    this.needsCfg = opts.needs ?? DEFAULT_NEEDS_CONFIG;
    // 兑换桥默认保守(关闭、rate=100、每日上限 50);WorldDef.economy.exchange 显式开启。
    this.exchangeCfg = opts.exchange ?? { enabled: false, rate: 100, dailyCapSilver: 50 };
    this.worldId = opts.worldId ?? 'pal';
    this.language = opts.language;     // 世界默认回话语言(undefined → llm-agent 走中文默认)
    // 旁听默认安全值(对标 spec §3):记忆扩散默认开(零成本),听众/插话双封顶。
    // 即便 host 不配置,默认也自洽安全——富者至多 1 次插话、穷/饥饿者只记不说。
    this.overhearCfg = {
      enabled: opts.overhear?.enabled ?? true,
      maxListeners: opts.overhear?.maxListeners ?? 4,
      interject: opts.overhear?.interject ?? true,
      interjectMaxPerTalk: opts.overhear?.interjectMaxPerTalk ?? 1,
    };
    this.onEvents = opts.onEvents;
    this.rooms = opts.rooms ?? ['广场', '酒馆', '集市'];
  }

  // --- ②层 world-scope key 包装(economy-multiverse spec §2)------------------
  /** ②层 store key → `w:<worldId>:…`。绝不动 Scope(='world'),仅包 key 字符串,与
   *  crossServerStable 谓词同轴(谓词以 key 字符串做层路由)。①层 key 不经此(裸/全局)。
   *  归一:旧的 `world:` 前缀(world:npcs / world:rels / world:market:rice)在 scope 化时
   *  剥掉那个冗余段 —— spec §2 目标即 `w:<id>:npcs` / `w:<id>:market:rice`(非 w:<id>:world:…),
   *  也让谓词正则 /^w:[^:]+:npcs$/ 命中 registry 镜像。npc:<id>:… 形原样带过。 */
  private wkey(k: string): string {
    const bare = k.startsWith('world:') ? k.slice('world:'.length) : k;
    return `w:${this.worldId}:${bare}`;
  }
  /** 对 host 暴露的 wkey 原语 —— host 侧②层裸写点(npc:<id>:pal 渲染锚 / world:tickSeq
   *  世界计数器)经此收口成 `w:<worldId>:…`,与 kit 内②层同前缀、随世界隔离。 */
  wkeyOf(k: string): string { return this.wkey(k); }

  /** 对 host 暴露的惰性迁移读(getScoped 的公共面)—— host 侧②层有**不可重建历史值**的
   *  key(如 world:tickSeq:tick 序号回退会让 DSN blob `tick-N.json` 撞名污染 replay)
   *  用它读取:pal 世界自动把既有裸值搬进 scoped(一次性、幂等);其余世界 scoped 直读,
   *  绝不误吞共享储上别的世界的裸历史。可重建的值(渲染锚,seed 每启重写)不需要它。 */
  async readScoped<T>(bareKey: string): Promise<T | null> { return this.getScoped<T>(bareKey); }

  /**
   * ②层 relationship 内容前缀(economy-multiverse spec §2)。RelationshipMemory 活在
   * `npc-player` Scope(非 `world`),wkey() 够不着 —— 改用 **内容 key 前缀** 把世界维度
   * 折进 REL_KEY。'pal'(旧/唯一历史世界)返 '' → 沿用裸 `relationship` key,零迁移继承
   * 既有亲密度;其余世界返 `w:<worldId>:` → 同 store 双世界同 npcId+playerId 互不撞库。
   * Scope 仍是 npc-player(crossServerStable 对它返 false)→ 热关系态照旧留本地、绝不逐回合
   * 镜像进链上共享层,与 PR-B 一致。 */
  private relPrefix(): string {
    return this.worldId === 'pal' ? '' : `w:${this.worldId}:`;
  }

  /**
   * ②层惰性迁移读(economy-multiverse spec §5 M1):scoped 命中优先;仅 worldId==='pal'
   * 时 scoped 缺、裸有 → 一次性搬运(写回 scoped,不带 ONCHAIN,与 backfillSilver 同模式),
   * 否则直读 scoped。幂等:scoped 命中即返,绝不再看裸 key;裸 key 不清除(非破坏性兜底)。
   * dwarf/cragheart/tiny 等无裸历史,直接 scoped 直读。
   */
  private async getScoped<T>(bareKey: string): Promise<T | null> {
    const wk = this.wkey(bareKey);
    const cur = await this.store.get<T>(W, wk);
    if (cur != null) return cur;                          // scoped 已有 → 命中优先,不回看裸
    if (this.worldId !== 'pal') return null;              // 非 pal 世界无裸历史
    const legacy = await this.store.get<T>(W, bareKey);   // 旧裸 key
    if (legacy == null) return null;
    await this.store.set(W, wk, legacy);                  // 搬运(无 ONCHAIN — 迁移是本地正名,非业务事件)
    return legacy;
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
  async createNpc(input: { name: string; owner: string; background: string; room?: string; startGcc?: number; startSilver?: number; id?: string; draft?: boolean }): Promise<string> {
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
    // 银两 = off-chain 游戏货币(无 ONCHAIN);默认底 10,让新 NPC 开局能买米。②层 → wkey。
    await this.store.set(W, this.wkey(silverKey(id)), input.startSilver ?? 10);
    await this.addToRegistry(id);
    void this.seedGoal(rec); // fire-and-forget: give the NPC a planning seed (kind=goal) so plan() has something to plan toward
    this.emit([{ kind: 'npcCreated', npcId: id, status: 'active' }], { now: Date.now() });
    return id;
  }

  /** Write a kind=goal unit from the NPC's persona — plan() synthesizes intentions
   *  FROM goals/beliefs, not facts, so without a goal seed there is nothing to plan. */
  private async seedGoal(rec: NpcRecord): Promise<void> {
    if (!this.memory || !rec.background) return;
    await this.memory.remember({
      slug: `${this.safeNpcSeg(rec.id)}_goal`,
      name: `${rec.name}的目标`,
      kind: 'goal',
      description: `履行${rec.name}的身份与职责：${rec.background.trim()}`,
      match: [rec.name, 'goal', '目标'],
    }, { corpus: await this.memoryCorpus(rec.id), evidence: await this.memoryEvidence(rec.id) }).catch(() => { /* never blocks */ });
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
        corpus: await this.memoryCorpus(npcId), now: opts.now, write: true, goals: opts.goals,
        aiggUrl: opts.aiggUrl, aiggKey: opts.aiggKey, model: opts.model, backend: opts.backend, timeout: opts.timeout,
      });
    } catch { return null; }
  }

  /**
   * Seed a standing GOAL (`kind=goal` unit) — what plan() plans FOR. The
   * planner's candidate selection is goal-seeded (explicit slugs → kind=goal
   * units → beliefs as fallback); free text in plan({goals}) does NOT work,
   * goals must exist as units first.
   */
  async rememberGoal(npcId: string, slug: string, text: string): Promise<boolean> {
    if (!this.memory) return false;
    try {
      await this.memory.remember({
        slug: slug.replace(/[^a-zA-Z0-9_一-鿿-]/g, '_'),
        name: slug, kind: 'goal', description: text, match: [slug]
      }, { corpus: await this.memoryCorpus(npcId), evidence: await this.memoryEvidence(npcId) });
      return true;
    } catch { return false; }
  }

  // --- 需求多轴(spec 里程碑①)----------------------------------------------
  /** 一拍需求:① dt 衰减(缺轴以 100 起算再衰);② 按 NPC 所在房间满足(cfg.satisfy[room]);
   *  ③ 写回 store(off-chain 易变,不带 ONCHAIN,同 diary/log)。纯 store + needs 纯函数,
   *  无 LLM、无链上;fair 心跳每 tick 对每个 NPC 调一次。失败静默。
   *  末尾轻量:最紧迫轴 fire-and-forget seed 一个 goal(复用 rememberGoal,无 memory 时返 false → 零副作用)。 */
  async tickNeeds(npcId: string, _now = Date.now(), dt = 1): Promise<NeedsState | null> {
    try {
      const rec = await this.getNpc(npcId);
      if (!rec) return null;
      const prev = (await this.getScoped<NeedsState>(needsKey(npcId))) ?? {};
      let next = decayNeeds(prev, this.needsCfg.axes, dt);     // 缺轴以 100 起算
      const sat = this.needsCfg.satisfy[rec.room];             // 所在房间满足表
      if (sat) for (const [axis, amt] of Object.entries(sat)) next = satisfy(next, axis, amt);
      await this.store.set(W, this.wkey(needsKey(npcId)), next); // ← ②层 wkey,不带 ONCHAIN
      // 最紧迫未满足需求 → seed goal(spec B,轻、失败静默;纯 store 世界无 memory 时无操作)
      const top = urgent(next, this.needsCfg.axes)[0];
      if (top && this.memory) {
        const lang = this.language ?? 'zh';
        const lack = summarizeNeeds({ [top]: next[top] }, this.needsCfg.axes, 30, lang);
        const goalText = lang === 'en' ? `You are ${lack} — see to it` : `你${lack}——设法满足这一需求`;
        void this.rememberGoal(npcId, `need_${top}`, goalText).catch(() => {});
      }
      return next;
    } catch { return null; }
  }

  /** 读当前需求(smoke / talk 注入用)。 */
  async needsOf(npcId: string): Promise<NeedsState> {
    return (await this.getScoped<NeedsState>(needsKey(npcId))) ?? {};
  }

  /** 显式满足一轴(进食/喝茶等「动作」回填):读 needs → satisfy → 写回 store(不带 ONCHAIN)。
   *  与 tradeRice 成对——消费抽走市场供给的同时回填食轴,否则下一拍仍匮乏、无限买空银两。 */
  async satisfyNeed(npcId: string, axis: string, amount: number): Promise<NeedsState> {
    const prev = (await this.getScoped<NeedsState>(needsKey(npcId))) ?? {};
    const next = satisfy(prev, axis, amount);
    await this.store.set(W, this.wkey(needsKey(npcId)), next);
    return next;
  }

  /**
   * The NPC's standing intentions — its `kind=plan` memory units (written by
   * plan(), never auto-acted by the kernel). The PlanExecutor consumes these
   * as its step queue; stale/archived plans (rationale died) are excluded —
   * the deterministic re-plan trigger.
   */
  async planSteps(npcId: string): Promise<Array<{ slug: string; text: string }>> {
    if (!this.memory) return [];
    try {
      const r = await this.memory.units({ corpus: await this.memoryCorpus(npcId) });
      return (r.units ?? [])
        .filter((u) => u.kind === 'plan' && u.status !== 'archived' && u.status !== 'stale')
        .map((u) => ({
          slug: u.path.split('/').slice(-2, -1)[0] ?? u.name,
          text: u.description || u.name
        }))
        .sort((a, b) => a.slug.localeCompare(b.slug));
    } catch { return []; }
  }

  /**
   * Hand an NPC a movement directive (a `goto` effect from talk). It does NOT
   * move the NPC — it queues the place/person name for the NPC's PlanExecutor,
   * which drains it next tick and walks there one hop at a time. In-process.
   */
  pushGoto(npcId: string, place: string): void {
    const p = place.trim();
    if (!p) return;
    const q = this.gotoInbox.get(npcId) ?? [];
    if (q[q.length - 1] === p) return; // de-dup a repeated directive
    q.push(p);
    this.gotoInbox.set(npcId, q);
  }

  /** Drain (and clear) an NPC's pending goto directives — the executor calls this. */
  takeGoto(npcId: string): string[] {
    const q = this.gotoInbox.get(npcId);
    if (!q || !q.length) return [];
    this.gotoInbox.delete(npcId);
    return q;
  }

  /**
   * dream — the nightly cognition pass (the Dream seam): reflect over the NPC's
   * episodes to form BELIEFS (model backend, e.g. gemma4), then verify — the
   * deterministic, no-LLM sweep that scores beliefs against outcome-tagged
   * episodes (confidence up; refuted → stale). Auto-fired after talk() on the
   * rich metabolism tier; callable explicitly by the host. Returns null without
   * a memory client + model config.
   */
  async dream(npcId: string, now: number = 0): Promise<{ beliefs: string[]; verified: number; diary?: string } | null> {
    if (!this.memory || !this.memoryModel) return null;
    const corpus = await this.memoryCorpus(npcId);
    // reflect (GLM) + verify — their own try: a reasoning-model hiccup
    // (content:null) here must NOT abort the 夜记 below.
    let beliefs: string[] = [];
    let verified = 0;
    try {
      const r = await this.memory.reflect({
        corpus, write: true,
        aiggUrl: this.memoryModel.aiggUrl, aiggKey: this.memoryModel.aiggKey,
        model: this.memoryModel.model, backend: this.memoryModel.backend, timeout: this.memoryModel.timeout,
      });
      const v = await this.memory.verify({ corpus, write: true, ...(now ? { now: new Date(now).toISOString() } : {}) });
      beliefs = (r.written ?? []) as string[];
      verified = Object.keys(v.verified ?? {}).length;
    } catch { /* reflect/verify failed — still write the diary from current beliefs */ }

    // 夜记 — a first-person diary of the night, written by a fast prose model
    // (qwen3-vl via the shim). The profile reads these; reflect only makes typed
    // beliefs, so the legible "心路" is otherwise invisible.
    let diary: string | undefined;
    try {
      const rec = await this.getNpc(npcId);
      // the night turns over the NEW conclusions if reflect formed any, else the
      // NPC's CURRENT beliefs (incl. the faculty belief a fresh loss just wrote).
      let topics = beliefs.slice();
      if (!topics.length) {
        try {
          const u = await this.memory.units({ corpus });
          topics = (u?.units ?? []).filter((x) => x.kind === 'belief' && x.status !== 'archived').map((x) => x.name).filter(Boolean).slice(-4);
        } catch { /* leave empty */ }
      }
      if (rec && topics.length) {
        const learned = topics.map((b) => b.replace(/_/g, ' ')).join('、');
        // ground the diary in WHO this NPC is — their card persona (background,
        // voice, register) — so the 夜记 stays in character, not generic prose.
        const persona = this.personaResolver?.(rec);
        const who = `你是${rec.name}${persona?.role ? `,${persona.role.split('\n')[0].slice(0, 80)}` : rec.background ? `,${rec.background.slice(0, 80)}` : ''}。`;
        const voice = [persona?.register && `说话口吻:${persona.register}`, persona?.tones?.length && `语气:${persona.tones.slice(0, 2).join('、')}`].filter(Boolean).join(';');
        const prose = await this.chatModel(
          `${who}${voice ? voice + '。' : ''}\n` +
          `今夜你把白日的遭遇又想了一遍,新悟出这些心得:${learned}。\n` +
          `严格贴合你的身份与口吻,用第一人称写一小段夜记(中文,2-3 句,旧时人记日记的语气,质朴有情绪),只写日记正文,不要跳出角色、不要解释。`,
          400, 'qwen3-vl'   // a fast non-reasoning model for clean prose — GLM-5-FP8 returns content:null on creative prompts
        );
        if (prose) {
          diary = prose.trim();
          await this.logEvent(npcId, 'dream', `夜里反思,炼出心得「${learned.slice(0, 24)}」,记了一篇夜记`);
          // store the 夜记 in pal's OWN store — it's a narrative artifact, not a
          // typed memory unit (aigg-memory's consolidate gates non-evidence units
          // out, so /memory/remember returns 200 but never persists a journal).
          try {
            const prev = (await this.getScoped<Array<{ date: string; text: string }>>(diaryKey(npcId))) ?? [];
            prev.push({ date: new Date(now || Date.now()).toISOString(), text: diary });
            await this.store.set(W, this.wkey(diaryKey(npcId)), prev.slice(-30));
          } catch { /* never blocks the dream */ }
        }
      }
    } catch { /* diary best-effort */ }
    return { beliefs, verified, ...(diary ? { diary } : {}) };
  }

  /** Freeform chat against the memoryModel backend (the OpenAI-compatible
   *  endpoint reflect/plan already use, e.g. the 0G zerog-shim). Returns the
   *  assistant text, or null on any failure — generative, best-effort. */
  private async chatModel(prompt: string, maxTokens = 1500, model?: string): Promise<string | null> {
    const mm = this.memoryModel;
    if (!mm) return null;
    try {
      const res = await fetch(`${mm.aiggUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(mm.aiggKey ? { authorization: `Bearer ${mm.aiggKey}` } : {}) },
        body: JSON.stringify({ model: model ?? mm.model ?? '', messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens }),
      });
      if (!res.ok) return null;
      const d = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      return d?.choices?.[0]?.message?.content ?? null;
    } catch { return null; }
  }

  /** Append a THIRD-PERSON line to the NPC's system log (off-chain, debug):
   *  every say / move / pitch / gossip / dream the NPC lives, in order. Distinct
   *  from the first-person 夜记 — this is the objective transcript a dev reads. */
  private async logEvent(npcId: string, kind: 'say' | 'move' | 'pitch' | 'gossip' | 'dream', text: string): Promise<void> {
    try {
      const prev = (await this.getScoped<Array<{ ts: number; kind: string; text: string }>>(logKey(npcId))) ?? [];
      prev.push({ ts: Date.now(), kind, text });
      await this.store.set(W, this.wkey(logKey(npcId)), prev.slice(-200));
    } catch { /* logging never blocks gameplay */ }
  }

  /**
   * npcProfile — the NPC's legible 履历: track record (counts of what it has
   * lived/learned/written) + its 心得 (active beliefs) + its 夜记 (diary) + the
   * third-person 系统日志 (debug transcript). The host renders the 人物档案 page.
   */
  async npcProfile(npcId: string): Promise<{
    npcId: string; name: string;
    track: { beliefs: number; journals: number; episodes: number; skill: number };
    beliefs: string[];
    diary: Array<{ date?: string; text: string }>;
    log: Array<{ ts: number; kind: string; text: string }>;
  }> {
    const rec = await this.getNpc(npcId);
    const name = rec?.name ?? npcId;
    const empty = { npcId, name, track: { beliefs: 0, journals: 0, episodes: 0, skill: 0 }, beliefs: [], diary: [], log: [] };
    try {
      // 夜记 + 系统日志 from pal's own store; 心得/阅历 (beliefs/episodes) from typed memory.
      const diary = ((await this.getScoped<Array<{ date: string; text: string }>>(diaryKey(npcId))) ?? []).slice(-12);
      const log = ((await this.getScoped<Array<{ ts: number; kind: string; text: string }>>(logKey(npcId))) ?? []).slice(-60);
      let beliefs = 0, episodes = 0;
      const beliefNames: string[] = [];
      if (this.memory) {
        const u = await this.memory.units({ corpus: await this.memoryCorpus(npcId) });
        for (const x of (u?.units ?? [])) {
          if (x.status === 'archived') continue;
          if (x.kind === 'belief') { beliefs++; if (x.name) beliefNames.push(x.name); }
          else if (x.kind === 'episodic') episodes++;
        }
      }
      return {
        npcId, name,
        track: { beliefs, journals: diary.length, episodes, skill: Math.round((beliefs * 10 + diary.length * 2) * 10) / 10 },
        beliefs: beliefNames.slice(0, 12),
        diary,
        log,
      };
    } catch { return empty; }
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
    const corpus = await this.memoryCorpus(input.npcId);
    const evidence = await this.memoryEvidence(input.npcId);
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
      void this.logEvent(input.npcId, 'pitch', `识破了 ${input.fromId.split(':').pop()} 的「${input.claim.slice(0, 16)}」(${gate.faculty ? '亲历过亏' : '听过街谈'}),分文未失`);
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
    const safe = (s: string) => s.replace(/[^a-zA-Z0-9_一-鿿-]/g, '_');
    const epSlug = safe(`${input.fromId}_${scam ? 'loss' : 'gain'}_${now}`);
    await this.memory?.remember({
      slug: epSlug,
      name: `${input.fromId} 的提议`, kind: 'episodic',
      description: scam
        ? `${rec.name} 信了 ${input.fromId} 的提议「${input.claim}」,交了 ${moved} GCC,结果被卷走(被坑)`
        : `${rec.name} 接受了 ${input.fromId} 的提议「${input.claim}」,获利 ${gain} GCC`,
      match: [input.fromId, input.npcId, 'pitch', 'deal', ...(scam ? ['trap'] : [])],
      outcome: scam ? 'loss' : 'gain',
    }, { corpus, evidence }).catch(() => {});

    // FACULTY belief (E1): a self-experienced scam loss IS a wary belief the NPC
    // learned itself — assert it on the FACULTY axis (asserted_by = self),
    // derived_from the loss episode so discernment(provenance) matches it via the
    // evidence and refuses this counterpart NEXT time. Deterministic, zero-LLM —
    // the v0.28 gate only reads kind:'belief' units, so the episode alone (which
    // the Dream may later generalize on the rich tier) never fires the gate.
    if (scam) {
      await this.memory?.remember({
        slug: safe(`learned_${input.fromId}_${now}`),
        name: `对 ${input.fromId} 的警惕(亲历)`,
        kind: 'belief',
        description: `${rec.name} 亲历过 ${input.fromId} 的「${input.claim}」之坑,认得这套把戏`,
        asserted_by: 'self',             // canonical self-marker (aigg-memory's _agent_id) → faculty axis
        derived_from: [epSlug],
        match: [input.fromId, 'trap'],
      }, { corpus, evidence }).catch(() => {});
    }

    // Dream so the accumulated losses become a verified belief (rich tier only; needs model)
    let belief: string | undefined;
    if (this.memoryModel) {
      const d = await this.dream(input.npcId, now).catch(() => null);
      belief = d?.beliefs?.[0];
    }
    void this.logEvent(input.npcId, 'pitch', scam
      ? `中了 ${input.fromId.split(':').pop()} 的「${input.claim.slice(0, 16)}」骗局,亏 ${moved}`
      : `接了 ${input.fromId.split(':').pop()} 的「${input.claim.slice(0, 16)}」,得利 ${gain}`);
    return { accepted: true, protected: false, deltaGcc: gain - moved, balanceGcc: balance, belief };
  }

  /**
   * gossip — street-talk, the SOCIAL axis (E2): `fromNpcId` warns `toNpcId`
   * about a counterpart (`about`, e.g. a scammer's id). Zero-LLM — two
   * deterministic writes into the LISTENER's corpus:
   *   1. the hearsay episode (what was heard; match carries `about` + 'trap'
   *      so the provenance scan finds it),
   *   2. a relayed BELIEF `asserted_by` the speaker, `derived_from` the
   *      hearsay — discernment(provenance) matches it via the evidence and
   *      splits it onto the social axis (asserted_by ≠ self). Unverified, so
   *      it carries the 0.5 prior: with θ ≤ 0.5 the listener refuses the
   *      counterpart WITHOUT personal loss; θ > 0.5 demands self-verification.
   * The speaker needs no NPC record (any id can talk); the listener does.
   */
  async gossip(input: { fromNpcId: string; toNpcId: string; about: string; text: string; now?: number }): Promise<boolean> {
    if (!this.memory) return false;
    const to = await this.getNpc(input.toNpcId);
    if (!to) return false;
    const from = await this.getNpc(input.fromNpcId);
    const speaker = from?.name ?? input.fromNpcId;
    const now = input.now ?? Date.now();
    const corpus = await this.memoryCorpus(input.toNpcId);
    const evidence = await this.memoryEvidence(input.toNpcId);
    const safe = (s: string) => s.replace(/[^a-zA-Z0-9_一-鿿-]/g, '_');
    const hearsay = safe(`streettalk_${input.about}_${now}`);
    try {
      await this.memory.remember({
        slug: hearsay, name: `${speaker} 的街谈`, kind: 'episodic',
        description: input.text,
        match: [input.about, 'pitch', 'deal', 'trap'],
        asserted_by: input.fromNpcId
      }, { corpus, evidence });
      await this.memory.remember({
        slug: safe(`warned_${input.about}_${now}`),
        name: `对 ${input.about} 的警惕(听自 ${speaker})`,
        kind: 'belief', description: input.text,
        asserted_by: input.fromNpcId,
        derived_from: [hearsay],
        match: [input.about, 'trap']
      }, { corpus, evidence });
      void this.logEvent(input.toNpcId, 'gossip', `听 ${speaker} 提起 ${input.about.split(':').pop()} 的事,记下警惕`);
      return true;
    } catch { return false; }
  }

  // --- 余杭米市 (rice market) ------------------------------------------------
  // 米×银=k constant-product over the per-wei-tested STF `trade` path. The
  // mapping puts 银两 in the STF's `usdc` slot — the SAME GCC meter every
  // other rail uses (pitch/donate/burn) — and 米 in its `balances` slot
  // (per-NPC holdings under npc:<id>:rice). 米价 = 银储/米储.

  async initRiceMarket(input: { rice: number; silver: number }): Promise<MarketState> {
    const m: MarketState = { riceReserve: input.rice, silverReserve: input.silver, supply: 0 };
    await this.store.set(W, this.wkey(RICE_MARKET), m, ONCHAIN);
    const now = Date.now();
    this.emit(
      [{ kind: 'marketInit', riceReserve: m.riceReserve, silverReserve: m.silverReserve, supply: 0 } as WorldEvent],
      { now, tx: { type: 'initMarket', riceReserve: m.riceReserve, silverReserve: m.silverReserve } as WorldTx }
    );
    return m;
  }

  async riceMarket(): Promise<MarketState | null> {
    // ②层惰性迁移(wkey 维度)先行,再跑「经济分离命名」的值内 schema 归一(两层正交叠加)。
    const m = await this.getScoped<MarketState>(RICE_MARKET);
    if (!m) return null;
    // 惰性迁移:旧 store 写的是 {gccReserve,usdcReserve,supply}(经济分离前的命名),
    // 正名后 m.riceReserve 读旧数据 = undefined → NaN。一次读即归一为新形(米储/银储)。
    const legacy = m as unknown as { gccReserve?: number; usdcReserve?: number };
    if (legacy.gccReserve !== undefined && m.riceReserve === undefined) {
      return { riceReserve: legacy.gccReserve, silverReserve: legacy.usdcReserve ?? 0, supply: m.supply };
    }
    return m;
  }

  /** spot 米价 (银两 per 米) — null until the market is seeded. */
  async ricePrice(): Promise<number | null> {
    const m = await this.riceMarket();
    return m ? m.silverReserve / m.riceReserve : null;
  }

  async riceHolding(npcId: string): Promise<number> {
    return (await this.getScoped<number>(riceKey(npcId))) ?? 0;
  }

  /** host-level provisioning (granary endowment) — like startGcc, not a trade. */
  async grantRice(npcId: string, amount: number): Promise<number> {
    const next = (await this.riceHolding(npcId)) + amount;
    await this.store.set(W, this.wkey(riceKey(npcId)), next, ONCHAIN);
    return next;
  }

  /** host-level provisioning(发银两)—— 给 NPC 补游戏货币,语义同 grantRice/startGcc,非交易。
   *  对外 public(seed/兜底用);内部转账走私有 addSilver。 */
  async grantSilver(npcId: string, amount: number): Promise<number> {
    return this.addSilver(npcId, amount);
  }

  /**
   * 暖启动迁移兜底:经济分离前落盘的 NPC 持久化了 npcKey+gccKey 但**从无** silverKey
   * (createNpc 默认底只在新建时写)。重启后 balanceSilver 对缺键返回 0 → 买不到米/下不了注。
   * 此处对「silverKey 完全缺失」的 NPC 一次性补到 floor;判据是缺键(undefined)而非 ===0,
   * 故交易归零的合法穷 NPC 不会被反复回填,seed 跨重启幂等。返回是否实际回填。
   */
  async backfillSilver(npcId: string, floor = 10): Promise<boolean> {
    const present = await this.getScoped<number>(silverKey(npcId));
    if (present != null) return false;            // 已有 silver 账(含合法的 0)→ 不动
    await this.store.set(W, this.wkey(silverKey(npcId)), Math.max(0, floor));
    return true;
  }

  /**
   * 囤米 (buy: 银→米) / 抛米 (sell: 米→银) via the pure STF — the rejection
   * paths (no market / bad amount / insufficient 银两 or 米) come back as
   * ok:false with the STF's reason, and nothing moves.
   */
  async tradeRice(input: { npcId: string; side: 'buy' | 'sell'; amount: number }): Promise<{
    ok: boolean; reason?: string; out: number; price: number | null; balanceSilver: number; rice: number;
  }> {
    const rec = await this.getNpc(input.npcId);
    if (!rec) throw new Error(`no npc ${input.npcId}`);
    const market = await this.riceMarket();
    // 货币边 = 银两(off-chain 游戏货币),不再读思考燃料 GCC —— 经济分离的核心修复。
    const silver = await this.balanceSilver(input.npcId);
    const rice = await this.riceHolding(input.npcId);
    const now = Date.now();
    const slice: WorldState = {
      npcs: {}, registry: [], relationships: {}, flags: {},
      balances: { [input.npcId]: rice },
      usdc: { [input.npcId]: silver },
      ...(market ? { market: { ...market } } : {})
    };
    const tx: WorldTx = { type: 'trade', agentId: input.npcId, side: input.side, amountIn: input.amount, now };
    const { state: applied, events } = applyTx(slice, tx, new DefaultGameRules(() => undefined));
    const rejected = events.find((e) => (e as { kind?: string }).kind === 'rejected') as { reason?: string } | undefined;
    if (rejected) {
      return { ok: false, reason: rejected.reason, out: 0, price: market ? market.silverReserve / market.riceReserve : null, balanceSilver: silver, rice };
    }
    const newRice = applied.balances[input.npcId];
    const newSilver = (applied.usdc ?? {})[input.npcId] ?? silver;
    await this.store.set(W, this.wkey(riceKey(input.npcId)), newRice, ONCHAIN);
    // 银两写回 off-chain 账(silverKey,无 ONCHAIN)—— 游戏货币永不上链。②层 → wkey。
    await this.store.set(W, this.wkey(silverKey(input.npcId)), newSilver);
    await this.store.set(W, this.wkey(RICE_MARKET), applied.market!, ONCHAIN);
    this.emit(events, { now, tx });
    const traded = events.find((e) => (e as { kind?: string }).kind === 'traded') as { out: number; price: number };
    return { ok: true, out: traded.out, price: traded.price, balanceSilver: newSilver, rice: newRice };
  }

  // --- 赌坊 (parimutuel on the rice price) -----------------------------------
  // 「今秋米价过 X 两?」— a binary market RESOLVED BY THE RICE AMM'S OWN PRICE
  // (internal, deterministic truth; no external oracle). Stakes escrow 银两
  // (the same GCC meter); winners split the whole pool pro-rata; no winners →
  // full refund. All via the per-wei-tested STF openMarket/bet/resolveMarket.

  async riceBets(): Promise<Record<string, PredictionMarket>> {
    return (await this.getScoped<Record<string, PredictionMarket>>(RICE_BETS)) ?? {};
  }

  async openRiceBet(input: { marketId: string; threshold: number }): Promise<{ ok: boolean; reason?: string }> {
    const markets = await this.riceBets();
    const now = Date.now();
    const slice: WorldState = { npcs: {}, registry: [], relationships: {}, flags: {}, balances: {}, markets: { ...markets } };
    const tx: WorldTx = { type: 'openMarket', marketId: input.marketId, threshold: input.threshold, now };
    const { state: applied, events } = applyTx(slice, tx, new DefaultGameRules(() => undefined));
    const rejected = events.find((e) => (e as { kind?: string }).kind === 'rejected') as { reason?: string } | undefined;
    if (rejected) return { ok: false, reason: rejected.reason };
    await this.store.set(W, this.wkey(RICE_BETS), applied.markets, ONCHAIN);
    this.emit(events, { now, tx });
    return { ok: true };
  }

  async placeRiceBet(input: { npcId: string; marketId: string; side: 'YES' | 'NO'; amount: number }): Promise<{
    ok: boolean; reason?: string; balanceSilver: number; yesPool: number; noPool: number;
  }> {
    const rec = await this.getNpc(input.npcId);
    if (!rec) throw new Error(`no npc ${input.npcId}`);
    const markets = await this.riceBets();
    // 下注本金 = 银两(赌的是生计,不是算力)。
    const silver = await this.balanceSilver(input.npcId);
    const now = Date.now();
    const slice: WorldState = {
      npcs: {}, registry: [], relationships: {}, flags: {}, balances: {},
      usdc: { [input.npcId]: silver }, markets: structuredClone(markets)
    };
    const tx: WorldTx = { type: 'bet', marketId: input.marketId, agentId: input.npcId, side: input.side, amount: input.amount, now };
    const { state: applied, events } = applyTx(slice, tx, new DefaultGameRules(() => undefined));
    const rejected = events.find((e) => (e as { kind?: string }).kind === 'rejected') as { reason?: string } | undefined;
    const m = (applied.markets ?? {})[input.marketId];
    if (rejected) return { ok: false, reason: rejected.reason, balanceSilver: silver, yesPool: m?.yesPool ?? 0, noPool: m?.noPool ?? 0 };
    await this.store.set(W, this.wkey(silverKey(input.npcId)), (applied.usdc ?? {})[input.npcId] ?? silver);
    await this.store.set(W, this.wkey(RICE_BETS), applied.markets, ONCHAIN);
    this.emit(events, { now, tx });
    return { ok: true, balanceSilver: (applied.usdc ?? {})[input.npcId] ?? silver, yesPool: m.yesPool, noPool: m.noPool };
  }

  /** 秋收结算 — resolves against the CURRENT rice price and pays every staker. */
  async resolveRiceBet(marketId: string): Promise<{
    ok: boolean; reason?: string; outcome?: 'YES' | 'NO'; price?: number; totalPool?: number; payouts?: number;
  }> {
    const markets = await this.riceBets();
    const market = await this.riceMarket();
    const stakers = Object.keys(markets[marketId]?.stakes ?? {});
    const usdc: Record<string, number> = {};
    // 赔付走银两账(下注本金即银两)。
    for (const id of stakers) usdc[id] = await this.balanceSilver(id);
    const now = Date.now();
    const slice: WorldState = {
      npcs: {}, registry: [], relationships: {}, flags: {}, balances: {},
      usdc, markets: structuredClone(markets), ...(market ? { market: { ...market } } : {})
    };
    const tx: WorldTx = { type: 'resolveMarket', marketId, now };
    const { state: applied, events } = applyTx(slice, tx, new DefaultGameRules(() => undefined));
    const rejected = events.find((e) => (e as { kind?: string }).kind === 'rejected') as { reason?: string } | undefined;
    if (rejected) return { ok: false, reason: rejected.reason };
    for (const id of stakers) {
      await this.store.set(W, this.wkey(silverKey(id)), (applied.usdc ?? {})[id] ?? usdc[id]);
    }
    await this.store.set(W, this.wkey(RICE_BETS), applied.markets, ONCHAIN);
    this.emit(events, { now, tx });
    const resolved = events.find((e) => (e as { kind?: string }).kind === 'marketResolved') as { outcome: 'YES' | 'NO'; price: number; totalPool: number; payouts: number };
    return { ok: true, outcome: resolved.outcome, price: resolved.price, totalPool: resolved.totalPool, payouts: resolved.payouts };
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
    this.emit([{ kind: 'activated', npcId, balanceGcc: amountGcc }], { now: Date.now() });
    return res;
  }

  /** Owner top-up (same mechanism as a patron donation). */
  async fund(npcId: string, gcc: number, opts: { apiKey?: string } = {}): Promise<number> { return this.addGccOrActivate(npcId, gcc, opts); }
  /** Anyone can sponsor an NPC's mind. First top-up of a draft activates it. */
  async donate(_donor: string, npcId: string, gcc: number, opts: { apiKey?: string } = {}): Promise<number> { return this.addGccOrActivate(npcId, gcc, opts); }

  async place(npcId: string, room: string): Promise<void> {
    if (!this.rooms.includes(room)) throw new Error(`no room ${room}`);
    const draft = this.draftNpcs.get(npcId);
    if (draft) {
      if (draft.room !== room) void this.logEvent(npcId, 'move', `走到 ${room}`);
      this.draftNpcs.set(npcId, { ...draft, room }); return; // move stays in RAM
    }
    const rec = await this.store.get<NpcRecord>(W, npcKey(npcId));
    if (!rec) throw new Error(`no npc ${npcId}`);
    if (rec.room !== room) void this.logEvent(npcId, 'move', `从 ${rec.room} 走到 ${room}`);
    await this.store.set(W, npcKey(npcId), { ...rec, room }, ONCHAIN);
    this.emit([{ kind: 'moved', npcId, room }], { now: Date.now() });
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

  /** 银两改账(off-chain 游戏货币)—— clamp ≥0,**永不**走 settlementLayer/balances 链上 rail,
   *  **永不**带 ONCHAIN。私有:对外发银两走 grantSilver,内部转账(交易/兑换)走此。 */
  private async addSilver(npcId: string, delta: number): Promise<number> {
    const bal = Math.max(0, (await this.balanceSilver(npcId)) + delta);
    await this.store.set(W, this.wkey(silverKey(npcId)), bal);
    return bal;
  }

  /**
   * 兑换桥(单向:银两 → GCC)—— 扣 off-chain 银两、铸入链上 GCC(经 addGcc:走
   * settlementLayer.deposit 或 store.set gccKey ONCHAIN),对齐 spec「GCC 只增于充值/兑换」。
   * 门控:开关 / 金额 / 余额 / 每日上限。**无反向**(GCC 不能换回银两 → 防游戏币套现真金)。
   */
  async exchangeSilverForGcc(input: { npcId: string; silver: number }): Promise<{
    ok: boolean; reason?: string; spentSilver: number; gotGcc: number; balanceSilver: number; balanceGcc: number;
  }> {
    const cfg = this.exchangeCfg;
    const balSilver = await this.balanceSilver(input.npcId);
    const balGcc = await this.balanceGcc(input.npcId);
    const fail = (reason: string) => ({ ok: false, reason, spentSilver: 0, gotGcc: 0, balanceSilver: balSilver, balanceGcc: balGcc });
    if (!cfg.enabled) return fail('exchange_disabled');
    if (!(input.silver > 0)) return fail('bad_amount');
    if (input.silver > balSilver) return fail('insufficient_silver');
    // 每日上限:按 store 里记录的当日累计判定(day = floor(now / 一天))。②层 → wkey。
    const dayKeyBare = `npc:${input.npcId}:exchange:day`;
    const dayKey = this.wkey(dayKeyBare);
    const today = Math.floor(Date.now() / 86_400_000);
    const rec = (await this.getScoped<{ day: number; used: number }>(dayKeyBare)) ?? { day: today, used: 0 };
    const usedToday = rec.day === today ? rec.used : 0;
    if (usedToday + input.silver > cfg.dailyCapSilver) return fail('daily_cap');
    // 扣银两(off-chain 销毁)+ 加 GCC(链上铸入,经 addGcc)。
    const newSilver = await this.addSilver(input.npcId, -input.silver);
    const gotGcc = input.silver / cfg.rate;
    const newGcc = await this.addGcc(input.npcId, gotGcc);
    await this.store.set(W, dayKey, { day: today, used: usedToday + input.silver });
    this.emit([{ kind: 'exchanged', npcId: input.npcId, silver: input.silver, gcc: gotGcc, balanceGcc: newGcc } as WorldEvent], { now: Date.now() });
    return { ok: true, spentSilver: input.silver, gotGcc, balanceSilver: newSilver, balanceGcc: newGcc };
  }

  private async addGcc(npcId: string, gcc: number): Promise<number> {
    // VALUE leg: deposit real GCC into the canonical settlement (Base TBA), so a
    // donate actually reaches the on-chain balance balanceGcc reads.
    if (this.settlementLayer) {
      await this.settlementLayer.deposit(npcId, Math.max(0, gcc));
      const bal = await this.balanceGcc(npcId);
      this.emit([{ kind: 'donated', npcId, balanceGcc: bal }], { now: Date.now() });
      return bal;
    }
    const bal = (await this.balanceGcc(npcId)) + Math.max(0, gcc);
    await this.store.set(W, gccKey(npcId), bal, ONCHAIN);
    this.emit([{ kind: 'donated', npcId, balanceGcc: bal }], { now: Date.now() });
    return bal;
  }

  private async addToRegistry(id: string): Promise<void> {
    const reg = (await this.getScoped<string[]>(REGISTRY)) ?? [];
    if (!reg.includes(id)) { reg.push(id); await this.store.set(W, this.wkey(REGISTRY), reg, ONCHAIN); }
  }

  private async addToRelIndex(rk: string): Promise<void> {
    const idx = (await this.getScoped<string[]>(REL_INDEX)) ?? [];
    if (!idx.includes(rk)) { idx.push(rk); await this.store.set(W, this.wkey(REL_INDEX), idx, ONCHAIN); }
  }

  /** fire-and-forget event emission — a throwing handler never breaks gameplay. */
  private emit(events: WorldEvent[], ctx: { now: number; tx?: WorldTx }): void {
    if (!events.length || !this.onEvents) return;
    try { this.onEvents(events, ctx); } catch { /* host handler error — swallowed */ }
  }

  /**
   * Reconstruct the full WorldState from the Store — the tick seam's stateRoot
   * input. Enumerates NPCs via the registry and relationships via the
   * REL_INDEX this class maintains. `flags` is always empty: SharedWorld does
   * not persist flag effects (their durable record is the event stream — see
   * onEvents). Draft NPCs (RAM-only, invisible) are excluded by design.
   */
  async snapshotState(): Promise<WorldState> {
    const registry = (await this.getScoped<string[]>(REGISTRY)) ?? [];
    const npcs: WorldState['npcs'] = {};
    const balances: WorldState['balances'] = {};
    for (const id of registry) {
      const rec = await this.store.get<NpcRecord>(W, npcKey(id));
      if (!rec) continue;
      npcs[id] = { ...rec, status: 'active' };
      balances[id] = await this.balanceGcc(id);
    }
    const relationships: WorldState['relationships'] = {};
    const rels = new RelationshipMemory(this.store, this.relPrefix());
    for (const rk of (await this.getScoped<string[]>(REL_INDEX)) ?? []) {
      const sep = rk.indexOf('|');
      if (sep <= 0) continue;
      relationships[rk] = await rels.get(rk.slice(0, sep), rk.slice(sep + 1));
    }
    return { npcs, registry, balances, relationships, flags: {} };
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
  /** 读银两(off-chain 游戏货币)—— 永远只在 store,绝不读 settlementLayer/balances 链上 rail。 */
  async balanceSilver(npcId: string): Promise<number> {
    return (await this.getScoped<number>(silverKey(npcId))) ?? 0;
  }
  /**
   * List NPCs. Persisted (activated) NPCs are visible to everyone; RAM drafts
   * are visible ONLY to their owner (pass `viewerId`). No viewer → activated only.
   */
  async listNpcs(viewerId?: string): Promise<NpcSummary[]> {
    const reg = (await this.getScoped<string[]>(REGISTRY)) ?? [];
    const out: NpcSummary[] = [];
    for (const id of reg) {
      const r = await this.getNpc(id);
      if (r) out.push({ id, name: r.name, room: r.room, owner: r.owner, balanceGcc: await this.balanceGcc(id), balanceSilver: await this.balanceSilver(id) });
    }
    if (viewerId) {
      for (const r of this.draftNpcs.values()) {
        if (r.owner === viewerId) out.push({ id: r.id, name: r.name, room: r.room, owner: r.owner, balanceGcc: 0, balanceSilver: 0, draft: true });
      }
    }
    return out;
  }
  async npcsInRoom(room: string, viewerId?: string): Promise<NpcSummary[]> { return (await this.listNpcs(viewerId)).filter((n) => n.room === room); }

  // --- interaction ---------------------------------------------------------
  /**
   * corpus and evidence paths for a given NPC — used by the memory client.
   *
   * Two layouts (multiverse spec §3 — memory follows the SOUL, not the world):
   *   minted agent → agent/<tokenId>/memory          (world-independent: the
   *     NPC keeps its 心得/识破 when it migrates to another world)
   *   draft/local  → <ns>npcs/<npcId>/memory         (legacy world-local)
   *
   * The mint is detected via the `npc:<id>:tokenId` identity key the host's
   * activator records in this same store (crossServerStable mirrors it — the
   * mapping federates with the NPC, so any server resolves the same corpus).
   * tokenIds are immutable → positives cached; negatives are NOT cached, so a
   * fresh mint switches the corpus on the very next turn, no restart.
   *
   * NB: aigg-memory's `_agent_id(corpus)` returns 'self' for any corpus whose
   * first segment is not 'npcs' — `agent/<tokenId>/…` therefore keeps the
   * faculty-belief axis (asserted_by:'self') working unchanged.
   */
  private readonly agentSegCache = new Map<string, string>();
  private async agentSeg(npcId: string): Promise<string | null> {
    const hit = this.agentSegCache.get(npcId);
    if (hit) return hit;
    const v = await this.store.get<string>(W, `npc:${npcId}:tokenId`);
    if (!v) return null;
    this.agentSegCache.set(npcId, String(v));
    return String(v);
  }
  /** path-safe corpus segment — npcIds contain ':' (e.g. "npc:鸿蒙:owner"), which the
   *  memory server rejects in paths. CJK is fine; only special chars are replaced. */
  private safeNpcSeg(npcId: string): string { return npcId.replace(/[^a-zA-Z0-9_一-鿿-]/g, '_'); }
  private async memoryCorpus(npcId: string): Promise<string> {
    const seg = await this.agentSeg(npcId);
    return seg ? `agent/${seg}/memory` : `${this.memoryNs}npcs/${this.safeNpcSeg(npcId)}/memory`;
  }
  private async memoryEvidence(npcId: string): Promise<string> {
    const seg = await this.agentSeg(npcId);
    return seg ? `agent/${seg}/evidence.jsonl` : `${this.memoryNs}npcs/${this.safeNpcSeg(npcId)}/evidence.jsonl`;
  }

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
  // _noOverhear: 内部递归防护(下划线 = 内部标志,不进 WorldDef/协议层)。overhear() 复用
  // talk() 让 rich 听众插话时传 true,使插话产生的 say 不再触发下一层旁听 → 递归深度恒为 1。
  async talk(input: { npcId: string; visitorId: string; text: string; outcome?: 'loss' | 'gain' | 'neutral'; sudo?: boolean; lang?: 'zh' | 'en'; _noOverhear?: boolean }): Promise<TalkResult> {
    const rec = await this.getNpc(input.npcId);
    if (!rec) throw new Error(`no npc ${input.npcId}`);

    // --- memory: select relevant units before LLM call (online, cheap) -------
    let memoryBundle: string | undefined;
    if (this.memory) {
      try {
        const sel = await this.memory.select(
          `${input.visitorId} ${input.text}`,
          { corpus: await this.memoryCorpus(input.npcId), n_best: 4, kinds: ['semantic', 'episodic'] }
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
            corpus: await this.memoryCorpus(input.npcId), mode: 'provenance', minConfidence: this.discernmentTheta,
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

    // 需求 → prompt:把当前需求摘成一行,与【记忆】/【裁断】同槽(经 personaFor→role 进 oracle)。
    // 行为仍由 AI 据此推理(spec 非目标:不硬规则驱动)。全足→summarize 返 '' →不注入。
    try {
      const lang = input.lang ?? this.language;     // 玩家覆盖 ?? 世界默认(与 say 同步)
      const needs = await this.needsOf(input.npcId);
      const line = summarizeNeeds(needs, this.needsCfg.axes, 30, lang);
      if (line) memoryBundle = `${memoryBundle ? memoryBundle + '\n' : ''}${lang === 'en' ? '[Needs] ' : '【需求】'}${line}`;
    } catch { /* needs 不可用 — 照常对话 */ }

    const persona = this.personaFor(rec, memoryBundle);
    persona.language = input.lang ?? this.language;   // 玩家覆盖 ?? 世界默认 → 注入 NPC 回话语言(undefined→中文)
    const relationships = new RelationshipMemory(this.store, this.relPrefix());
    const balance0 = await this.balanceGcc(input.npcId);
    const beforeRel = await relationships.get(input.npcId, input.visitorId);
    const before = beforeRel.affinity;

    // metabolism gate (deterministic, pure) — drives tier/starving/rich + the
    // hunger fallback, exactly as the in-place LlmAgent did via onMetabolism.
    const decision = this.metabolism.decide(balance0);
    const starving = decision.starving;
    const tier = decision.starving ? '🥵饥饿' : (decision.tier.label ?? decision.tier.id);
    const richTier = !decision.starving && (decision.tier.label === '充盈' || decision.tier.id === 'r');

    // who's actually speaking — a fellow NPC (钱塘大集) or the player. The oracle
    // frames/addresses the line by this, so 洪大夫 talking to 香兰 says「香兰」not「小李子」.
    const visNpc = await this.getNpc(input.visitorId);
    const interlocutor = visNpc
      ? { name: visNpc.name, kind: 'npc' as const }
      : { name: input.visitorId.split(':').pop() || input.visitorId, kind: 'player' as const };

    // AI (impure oracle) — quarantined. Starving → scripted line, NO LLM, NO cost.
    const oracleOut = decision.canThink
      ? await this.oracle.produce({ npcId: input.npcId, playerId: input.visitorId, interlocutor, text: input.text, persona, balanceGcc: balance0, rel: beforeRel })
      : { say: `（${rec.name} 灵力枯竭，无法回应……需要有人为 TA 充值 GCC）`, effects: [] as Effect[], gccCost: 0, usage: undefined, attestation: undefined };
    const cost = oracleOut.gccCost;

    // EXECUTION (pure STF) — validate + apply effects + burn on a minimal state
    // slice (the deterministic core; same DefaultGameRules anti-cheat as before).
    const rk = relKey(input.npcId, input.visitorId);
    const rules = new DefaultGameRules((id) => (id === input.npcId ? persona : undefined));
    const slice: WorldState = { npcs: { [input.npcId]: { ...rec, status: 'active' } }, registry: [], balances: { [input.npcId]: balance0 }, relationships: { [rk]: beforeRel }, flags: {} };
    const now = Date.now();
    const talkTx: WorldTx = { type: 'applyTalk', npcId: input.npcId, playerId: input.visitorId, effects: oracleOut.effects, gccCost: cost, now };
    const { state: applied, events: stfEvents } = applyTx(slice, talkTx, rules);
    const rel = applied.relationships[rk];
    const balance = applied.balances[input.npcId];

    // persist via the existing tiering-safe write paths: relationship delta + burn.
    const netDelta = rel.affinity - before;
    if (netDelta !== 0) {
      await relationships.applyDelta(input.npcId, input.visitorId, netDelta, [], now);
      await this.addToRelIndex(rk);
    }
    if (cost > 0) await this.store.set(W, gccKey(input.npcId), balance, ONCHAIN);

    // tick seam: the say line (narrative, oracle-produced) + the tx's STF events
    this.emit(
      [
        ...(oracleOut.say ? [{ kind: 'say', npcId: input.npcId, playerId: input.visitorId, text: oracleOut.say } as WorldEvent] : []),
        ...stfEvents
      ],
      { now, tx: talkTx }
    );

    if (oracleOut.say) void this.logEvent(input.npcId, 'say', `对 ${interlocutor.name} 说:「${oracleOut.say.slice(0, 40)}」`);

    // movement intent (goto 算子) — narrative-control gate (Ford 原则,
    // docs/specs/narrative-control.md):「叙事即权力,权力必须有闸」。
    // Direct command belongs to SUDO (world operator) and the NPC's OWNER (its
    // 编剧). Everyone else can only PERSUADE — the LLM may emit goto, but the
    // NPC obeys only past the affinity threshold: guests influence through
    // memory and 好感, never by fiat.
    const mayCommand = input.sudo === true || input.visitorId === rec.owner;
    const persuaded = rel.affinity >= this.commandAffinity;
    for (const e of oracleOut.effects) {
      if (e.kind !== 'goto' || !e.place?.trim()) continue;
      const place = e.place.trim();
      if (mayCommand || persuaded) {
        this.pushGoto(input.npcId, place);
        void this.logEvent(input.npcId, 'move', `打算动身去「${place}」${mayCommand ? '' : `(被${interlocutor.name}说动)`}`);
      } else {
        void this.logEvent(input.npcId, 'move', `${interlocutor.name} 劝它去「${place}」——交情未到,嘴上应了,脚下没动`);
      }
    }

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
      const corpus = await this.memoryCorpus(input.npcId);
      const evidence = await this.memoryEvidence(input.npcId);
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

    // --- 旁听(overhearing): 同房间其他 NPC 听见这句说出口的话 → 亲历级 episodic + (rich)插话 ---
    // 触发门控:旁听开 + 这一回合有说出口的 say(没说出口的话没人能听见)+ 非插话回合
    // (_noOverhear 防递归——插话本身复用 talk() 产生的 say 不再引爆下一层)。
    // 教训C:整段 fire-and-forget + .catch —— talk() 的返回值/时延绝不受旁听影响。
    if (this.overhearCfg.enabled && oracleOut.say && !input._noOverhear) {
      void this.overhear({
        speakerId: input.npcId, speakerName: rec.name, room: rec.room,
        interlocutorId: input.visitorId, interlocutorName: interlocutor.name,
        said: oracleOut.say, outcome: input.outcome, now,
      }).catch(() => { /* 教训C:任何旁听错误绝不影响 talk 返回 */ });
    }

    return result;
  }

  /**
   * 旁听 —— 在【说话者 say 已 emit 之后】fire-and-forget 触发(绝不进 talk 主路径)。五步:
   *   1. 选听众:npcsInRoom(room) 排除说话者与对话者(若是 NPC)→ 按 id 稳定排序 → slice(maxListeners)。
   *   2. per-overhearer metabolism 门控(读各自新鲜余额,纯函数 decide,无随机):
   *        starving → 整段跳过(连 remember 都不写,与说话者自己 remember 的 !starving 门一致);
   *        非饥饿(lean/rich)→ 写亲历级 episodic remember 进【该听众自己】的 corpus(零成本);
   *        rich → 之上【有资格】插话。
   *   3. remember:corpus/evidence 必须传【听众 o.id】,绝不写说话者(防裸键/自证泄漏)。
   *   4. 插话:rich 听众子集按 id 稳定排序取前 interjectMaxPerTalk 个授权,复用 talk(_noOverhear:true)
   *        走完整 STF/applyTalk → 烧 GCC + emit say/burned/affinityChanged + 持久化余额(账本一致、tick 可锚定)。
   *   5. 系统日志:复用既有 'gossip' kind 记一条第三人称旁听日志。
   * 成本封顶B:maxListeners≤4 截断旁听者(remember ≤4 次);interjectMaxPerTalk≤1 截断插话
   *            ——一句话最多引爆 1 次额外推理。递归防护:插话带 _noOverhear=true,旁听深度恒为 1。
   * 确定性铁律E:听众选取/rich 子集/被授权插话集全部在 Promise.all 之前一次性按已排序 id 算好,
   *            并发 map 内仅按「我的 id 是否在该集合」判定 → 无随机源、无竞态、可重放。
   */
  private async overhear(input: {
    speakerId: string; speakerName: string; room: string;
    interlocutorId: string; interlocutorName: string;
    said: string; outcome?: 'loss' | 'gain' | 'neutral'; now: number;
  }): Promise<void> {
    if (!this.memory) return;

    // 步骤1:同房间听众 → 排除说话者与对话者(对话者是玩家时其 id 不在 registry,filter 自然不命中)
    // → 按 id 字典序稳定排序(确定性,无随机)→ slice(maxListeners)(成本封顶B 第一闸)。
    const listeners = (await this.npcsInRoom(input.room))
      .filter((n) => n.id !== input.speakerId && n.id !== input.interlocutorId)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, this.overhearCfg.maxListeners);
    if (listeners.length === 0) return;

    // 步骤2(预算):per-overhearer 门控,一次性算好「非饥饿听众」与「rich 听众」(确定性,纯函数)。
    // 在 Promise.all 之前定下被授权插话集,避免并发竞态破坏确定性(教训E)。
    const gated = await Promise.all(listeners.map(async (o) => {
      const bal = await this.balanceGcc(o.id);
      const d = this.metabolism.decide(bal);
      const rich = !d.starving && (d.tier.label === '充盈' || d.tier.id === 'r'); // 与主路径 richTier 同判据
      return { o, starving: d.starving, rich };
    }));
    // 被授权插话集:rich 子集(已随 listeners 按 id 稳定排序)取前 interjectMaxPerTalk 个 id。
    // 成本封顶B 第二闸:即便多个 rich 听众,也只 ≤interjectMaxPerTalk 个真正插话。
    const interjectIds = new Set<string>(
      this.overhearCfg.interject
        ? gated.filter((g) => g.rich).map((g) => g.o.id).slice(0, this.overhearCfg.interjectMaxPerTalk)
        : [] // interject===false → 全员只 remember 不插话(更保守开关)
    );

    // 步骤3-5:并发处理(避免串行 await 拖慢后台);插话授权用预算好的 interjectIds 判定。
    await Promise.all(gated.map(async ({ o, starving, rich }) => {
      if (starving) return; // 饥饿者整段跳过:不 remember、不插话、不记日志

      // 步骤3:亲历级 episodic remember 进【听众自己】的 corpus(零成本、离账本、fire-and-forget)。
      // outcome:'loss' → match 含 'trap' → discernment 的 provenance 扫描命中 → 亲历级警惕信念。
      const safe = (s: string) => s.replace(/[^a-zA-Z0-9_一-鿿-]/g, '_');
      const corpus = await this.memoryCorpus(o.id);   // 听众 o.id,绝不是说话者(防裸键泄漏)
      const evidence = await this.memoryEvidence(o.id);
      await this.memory!.remember({
        slug: safe(`overheard_${input.speakerId}_${input.now}`),
        name: `旁听 ${input.speakerName}`,
        kind: 'episodic',
        description: `${input.speakerName} 对 ${input.interlocutorName} 说：「${input.said}」（${o.name} 在旁亲耳听到）`,
        match: [input.speakerId, input.speakerName, input.interlocutorName, 'overheard', '旁听',
          ...(input.outcome === 'loss' ? ['trap'] : [])],
        // 旁观所得 → 仍记说话者为来源,但这是【亲历】(o 亲耳听到),非二手街谈:不设 asserted_by≠self,
        // 让 discernment 的 faculty 轴(asserted_by:'self')命中 → 亲历级警惕,不依赖二手 gossip。
        ...(input.outcome ? { outcome: input.outcome } : {}),
      }, { corpus, evidence }).catch(() => { /* 离账本、fire-and-forget,绝不抛 */ });

      // 步骤5:系统日志(复用既有 'gossip' kind,无需扩联合,fire-and-forget)。
      void this.logEvent(o.id, 'gossip', `旁听 ${input.speakerName} 对 ${input.interlocutorName} 的话,记下`);

      // 步骤4:插话 —— 仅被授权的 rich 听众(确定性首个 rich + ≤interjectMaxPerTalk)。
      // 复用 talk(_noOverhear:true) 走完整账本:烧 GCC + emit say/burned + 持久化余额 → tick 可锚定。
      // _noOverhear 封死递归:插话的 say 不再触发对其它听众的二次旁听(教训B 核心)。
      if (rich && interjectIds.has(o.id)) {
        await this.talk({
          npcId: o.id, visitorId: input.speakerId,
          text: `〔旁听插话〕${input.said}`, sudo: false, _noOverhear: true,
        }).catch(() => { /* 插话失败绝不影响其它听众的 remember */ });
      }
    }));
  }
}
