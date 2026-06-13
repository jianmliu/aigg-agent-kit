import type { Agent } from './agent';
import type { Perception } from '../ports/ports';
import type { AgentIntent } from '../intent/agent-intent';
import type { InferenceProvider, InferenceUsage } from '../inference/provider';
import { resolveAddressing, type NpcPersona } from '../persona/persona';
import { RelationshipMemory } from '../memory/relationship';
import { parseAgentIntent } from '../intent/parse';
import { hungerIntent, type Metabolism, type MetabolicDecision } from '../economy/metabolism';

export interface LlmAgentOptions {
  persona: NpcPersona;
  provider: InferenceProvider;
  relationships: RelationshipMemory;
  temperature?: number;
  /** called after each inference with the metering result (for settlement). */
  onUsage?: (usage: InferenceUsage, perception: Perception) => void;
  /** I-phase: gate/route thinking by the NPC's GCC balance ("cognitive metabolism"). */
  metabolism?: Metabolism;
  /** read the NPC's current GCC balance (e.g. TbaAgentWallet.balanceGcc). */
  readBalanceGcc?: (npcId: string) => Promise<number | null>;
  /** scripted line used when the NPC is starving (can't afford to think). */
  hungerLine?: string;
  /** observe the metabolic decision each turn (HUD / logging). */
  onMetabolism?: (decision: MetabolicDecision, perception: Perception) => void;
  /** pick the provider for a decision's model tier; defaults to the fixed provider. */
  resolveProvider?: (decision: MetabolicDecision) => InferenceProvider;
}

/**
 * LlmAgent — the engine-neutral NPC brain. On each perception it loads the
 * per-player relationship, builds a prompt from persona + relationship + the
 * incoming utterance, asks the InferenceProvider for a structured AgentIntent,
 * validates it, and returns it. It does NOT apply effects — that is the
 * AgentRuntime + EffectResolver's job (so the brain stays side-effect free).
 */
export class LlmAgent implements Agent {
  readonly npcId: string;
  private readonly persona: NpcPersona;
  private readonly provider: InferenceProvider;
  private readonly relationships: RelationshipMemory;
  private readonly temperature: number;
  private readonly onUsage?: LlmAgentOptions['onUsage'];
  private readonly metabolism?: Metabolism;
  private readonly readBalanceGcc?: LlmAgentOptions['readBalanceGcc'];
  private readonly hungerLine?: string;
  private readonly onMetabolism?: LlmAgentOptions['onMetabolism'];
  private readonly resolveProvider?: LlmAgentOptions['resolveProvider'];

  constructor(opts: LlmAgentOptions) {
    this.persona = opts.persona;
    this.npcId = opts.persona.id;
    this.provider = opts.provider;
    this.relationships = opts.relationships;
    this.temperature = opts.temperature ?? 0.7;
    this.onUsage = opts.onUsage;
    this.metabolism = opts.metabolism;
    this.readBalanceGcc = opts.readBalanceGcc;
    this.hungerLine = opts.hungerLine;
    this.onMetabolism = opts.onMetabolism;
    this.resolveProvider = opts.resolveProvider;
  }

  async perceive(perception: Perception): Promise<AgentIntent | null> {
    // Only act on perceptions addressed to this NPC (or untargeted interactions).
    if (perception.npcId && perception.npcId !== this.npcId) return null;
    if (perception.kind !== 'interaction' && perception.kind !== 'dialog-line') return null;

    // Cognitive metabolism: if a metabolism is configured, the NPC's GCC balance
    // gates/routes its thinking. Starving → scripted line, NO LLM call, NO GCC burn.
    let provider = this.provider;
    if (this.metabolism) {
      const balance = this.readBalanceGcc ? await this.readBalanceGcc(this.npcId) : null;
      const decision = this.metabolism.decide(balance);
      this.onMetabolism?.(decision, perception);
      if (!decision.canThink) {
        return hungerIntent(this.hungerLine);
      }
      if (this.resolveProvider) provider = this.resolveProvider(decision);
    }

    const rel = await this.relationships.get(this.npcId, perception.playerId);
    // address by who's actually speaking: a fellow NPC by name, the player by
    // the affinity-tiered title. NPC↔NPC must NOT borrow the player's title.
    const npcSpeaker = perception.interlocutor?.kind === 'npc';
    const addressing = npcSpeaker ? perception.interlocutor!.name : resolveAddressing(this.persona, rel.affinity);
    const prompt = this.buildPrompt(perception, addressing, rel.affinity, rel.tags);

    const system = this.persona.language === 'en'
      ? 'You are a game NPC. Output STRICTLY one JSON object, no explanation or extra text. Your `say` line MUST be in English.'
      : '你是一个游戏 NPC。严格只输出一个 JSON 对象，不要任何解释或多余文字。';
    const result = await provider.complete({
      prompt,
      system,
      temperature: this.temperature
    });
    if (result.usage && this.onUsage) this.onUsage(result.usage, perception);

    const parsed = parseAgentIntent(result.text);
    if (!parsed.ok || !parsed.intent) {
      // graceful fallback: stay in character but emit nothing structured
      return { say: undefined, effects: [], emotion: 'confused' };
    }
    return parsed.intent;
  }

  private buildPrompt(perception: Perception, addressing: string, affinity: number, tags: string[]): string {
    const p = this.persona;
    const lines: string[] = [];
    lines.push(`你是 ${p.name}${p.aliases?.length ? `（又称${p.aliases.join('、')}）` : ''}，${p.role}。`);
    if (p.tones?.length) lines.push(`语气：${p.tones.join('、')}`);
    if (p.traits?.length) lines.push(`性格：${p.traits.join('、')}`);
    if (p.motivations?.length) lines.push(`动机：${p.motivations.join('、')}`);
    if (p.register) lines.push(`说话方式：${p.register}`);
    if (p.knowledge?.scopeRule) lines.push(`知识范围：${p.knowledge.scopeRule}`);
    if (p.knowledge?.spoilerRule) lines.push(`剧透限制：${p.knowledge.spoilerRule}`);
    if (p.taboos?.length) lines.push(`禁忌：${p.taboos.join('；')}`);
    if (p.boundaries?.length) lines.push(`底线：${p.boundaries.join('；')}`);
    lines.push('');
    const npcSpeaker = perception.interlocutor?.kind === 'npc';
    // who you're talking to: a fellow townsperson (NPC) by name, or the player.
    const who = npcSpeaker ? `同镇的 ${addressing}` : '这名玩家';
    lines.push(`【你与${who}的关系】好感度 ${affinity}${tags.length ? `，标签：${tags.join('、')}` : ''}。你称呼${npcSpeaker ? '对方' : '他'}为「${addressing}」。`);
    lines.push('');
    lines.push(`${addressing}对你说：「${perception.text ?? ''}」`);
    lines.push('');
    // 输出语言只管 say 字段;effects/原因等结构标签语言不影响解析。'en' 世界/玩家 → 英文对白。
    if (p.language === 'en') {
      lines.push('Output STRICTLY one JSON object with fields:');
      lines.push(`- say: your in-character line spoken to ${addressing} — REPLY IN ENGLISH; don't mistake who you're addressing`);
      lines.push('- effects: array, optional. allowed items:');
      lines.push('  {"kind":"adjustRelationship","delta":int(-20~20),"reason":"..."}');
      lines.push('  {"kind":"setFlag","flag":"string","value":number}');
      lines.push('  {"kind":"goto","place":"a place or person"} — emit when asked to go somewhere or you decide to head to a place/person (e.g. "Town Hall","Central Plaza","Flora"); you only form the intent, travel takes time');
      lines.push('- emotion: how you feel right now (optional)');
      lines.push('Example: {"say":"Good to see you again.","effects":[{"kind":"adjustRelationship","delta":5,"reason":"bought me a drink"}],"emotion":"glad"}');
    } else {
      lines.push('请只输出一个 JSON 对象，字段：');
      lines.push(`- say: 你的一句中文对白（符合你的身份，是对${addressing}说的话，不要把对方错认成别人）`);
      lines.push('- effects: 数组，可选。允许的项：');
      lines.push('  {"kind":"adjustRelationship","delta":整数(-20~20),"reason":"原因"}');
      lines.push('  {"kind":"setFlag","flag":"字符串","value":数字}');
      lines.push('  {"kind":"goto","place":"地名或人名"} —— 当对方请你去某处、或你决意动身前往某地/找某人时输出(如「客栈」「集市」「张四」);你只是起意，真正走过去要花时间');
      lines.push('- emotion: 你此刻的情绪（可选）');
      lines.push('示例：{"say":"哈哈，又见面了！","effects":[{"kind":"adjustRelationship","delta":5,"reason":"玩家请喝酒"}],"emotion":"高兴"}');
    }
    return lines.join('\n');
  }
}
