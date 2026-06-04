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
  Store, Scope, InferenceProvider, NpcPersona, Actuator, StateDelta, SayOptions, Metabolism
} from '@onchainpal/npc-agent';
import type { AiggMemoryClient } from '@onchainpal/npc-agent';

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
}
export interface NpcSummary { id: string; name: string; room: string; owner: string; balanceGcc: number }
export interface TalkResult {
  said: string | null;
  affinity: number;
  dAffinity: number;
  addressing: string;
  tier: string;
  starving: boolean;
  costGcc: number;
  balanceGcc: number;
}

class NoopActuator implements Actuator {
  async say(_n: string, _l: string, _o?: SayOptions): Promise<void> {}
  async apply(_d: StateDelta): Promise<void> {}
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
}

export class SharedWorld {
  private readonly store: Store;
  private readonly provider: InferenceProvider;
  private readonly metabolism: Metabolism;
  private readonly memory?: AiggMemoryClient;
  readonly rooms: string[];

  constructor(opts: SharedWorldOptions) {
    this.store = opts.store;
    this.provider = opts.provider;
    this.metabolism = opts.metabolism ?? DEFAULT_METABOLISM;
    this.memory = opts.memory;
    this.rooms = opts.rooms ?? ['广场', '酒馆', '集市'];
  }

  // --- authoring -----------------------------------------------------------
  /** Create + place an AI NPC from a free-text background, optionally pre-funded. */
  async createNpc(input: { name: string; owner: string; background: string; room?: string; startGcc?: number; id?: string }): Promise<string> {
    const id = input.id ?? `npc:${input.name}:${input.owner}`;
    const room = input.room && this.rooms.includes(input.room) ? input.room : this.rooms[0];
    const rec: NpcRecord = { id, name: input.name, owner: input.owner, room, background: input.background.trim() };
    await this.store.set(W, npcKey(id), rec, ONCHAIN);
    await this.store.set(W, gccKey(id), input.startGcc ?? 0, ONCHAIN);
    const reg = (await this.store.get<string[]>(W, REGISTRY)) ?? [];
    if (!reg.includes(id)) { reg.push(id); await this.store.set(W, REGISTRY, reg, ONCHAIN); }
    return id;
  }

  /** Owner top-up (same mechanism as a patron donation). */
  async fund(npcId: string, gcc: number): Promise<number> { return this.addGcc(npcId, gcc); }
  /** Anyone can sponsor an NPC's mind. */
  async donate(_donor: string, npcId: string, gcc: number): Promise<number> { return this.addGcc(npcId, gcc); }

  async place(npcId: string, room: string): Promise<void> {
    const rec = await this.getNpc(npcId);
    if (!rec) throw new Error(`no npc ${npcId}`);
    if (!this.rooms.includes(room)) throw new Error(`no room ${room}`);
    await this.store.set(W, npcKey(npcId), { ...rec, room }, ONCHAIN);
  }

  private async addGcc(npcId: string, gcc: number): Promise<number> {
    const bal = (await this.balanceGcc(npcId)) + Math.max(0, gcc);
    await this.store.set(W, gccKey(npcId), bal, ONCHAIN);
    return bal;
  }

  // --- discovery -----------------------------------------------------------
  async getNpc(npcId: string): Promise<NpcRecord | null> { return this.store.get<NpcRecord>(W, npcKey(npcId)); }
  async balanceGcc(npcId: string): Promise<number> { return (await this.store.get<number>(W, gccKey(npcId))) ?? 0; }
  async listNpcs(): Promise<NpcSummary[]> {
    const reg = (await this.store.get<string[]>(W, REGISTRY)) ?? [];
    const out: NpcSummary[] = [];
    for (const id of reg) {
      const r = await this.getNpc(id);
      if (r) out.push({ id, name: r.name, room: r.room, owner: r.owner, balanceGcc: await this.balanceGcc(id) });
    }
    return out;
  }
  async npcsInRoom(room: string): Promise<NpcSummary[]> { return (await this.listNpcs()).filter((n) => n.room === room); }

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
      onUsage: (u) => { cost = u.gccCost ?? 0; balance -= cost; }
    });
    const resolver = new EffectResolver(new DefaultGameRules((id) => (id === input.npcId ? persona : undefined)));
    const runtime = new AgentRuntime({ agent, resolver, relationships, actuator: new NoopActuator(), now: () => Date.now() });

    const before = (await relationships.get(input.npcId, input.visitorId)).affinity;
    const res = await runtime.handle({ kind: 'interaction', npcId: input.npcId, playerId: input.visitorId, text: input.text } as any);
    if (cost > 0) await this.store.set(W, gccKey(input.npcId), balance, ONCHAIN); // persist the burn on-chain

    const rel = await relationships.get(input.npcId, input.visitorId);
    const result: TalkResult = {
      said: res.said,
      affinity: rel.affinity,
      dAffinity: rel.affinity - before,
      addressing: resolveAddressing(persona, rel.affinity),
      tier,
      starving,
      costGcc: cost,
      balanceGcc: balance
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
