/**
 * inference-oracle — the AI boundary for the deterministic world STF.
 *
 * The STF (world-stf.ts) is pure + reproducible; the NON-deterministic LLM
 * reasoning is quarantined HERE, behind an oracle interface. An InferenceOracle
 * takes a talk context and produces the EFFECTS (say + relationship/flag deltas
 * + GCC cost), optionally with an `Attestation` (the provider's signed hash of
 * prompt+response+model). That output becomes the input data of a deterministic
 * `applyTalk` tx; the STF only applies it. A fraud proof then checks the STF
 * applied the (signed) effects correctly — it never re-runs the LLM.
 *
 * LlmInferenceOracle wraps an InferenceProvider, reusing the kit's pure pieces
 * (`Metabolism.decide` gate, `resolveAddressing`, `parseAgentIntent`).
 */
import { resolveAddressing, parseAgentIntent } from '@onchainpal/npc-agent';
import type { Effect, NpcPersona, RelationshipState, Attestation, InferenceProvider, Metabolism } from '@onchainpal/npc-agent';

export interface OracleInput {
  npcId: string;
  playerId: string;
  text: string;
  persona: NpcPersona;
  /** the NPC's GCC balance (gates thinking via metabolism). null = unknown. */
  balanceGcc: number | null;
  /** the current per-visitor relationship (for prompt context). */
  rel: RelationshipState;
}

export interface OracleOutput {
  say: string | null;
  effects: Effect[];
  /** GCC this turn's thinking cost (becomes the applyTalk burn). */
  gccCost: number;
  emotion?: string;
  /** provider signature over prompt+response+model — the committable provenance. */
  attestation?: Attestation;
  /** true when the NPC was too drained to think (scripted fallback, no LLM, no cost). */
  starving?: boolean;
}

export interface InferenceOracle {
  produce(input: OracleInput): Promise<OracleOutput>;
}

const SYSTEM = '你是一个游戏 NPC。严格只输出一个 JSON 对象，不要任何解释或多余文字。';

export interface LlmInferenceOracleOptions {
  provider: InferenceProvider;
  /** optional cognitive metabolism — starving NPCs return a scripted line, no LLM, no GCC. */
  metabolism?: Metabolism;
  /** line spoken when starving. */
  hungerLine?: string;
  temperature?: number;
}

export class LlmInferenceOracle implements InferenceOracle {
  constructor(private readonly o: LlmInferenceOracleOptions) {}

  async produce(input: OracleInput): Promise<OracleOutput> {
    // metabolism gate (deterministic): broke → scripted line, no LLM, no burn.
    if (this.o.metabolism) {
      const d = this.o.metabolism.decide(input.balanceGcc);
      if (!d.canThink) {
        return { say: this.o.hungerLine ?? '（神色倦怠）……我此刻心力交瘁，容我缓一缓。', effects: [], gccCost: 0, emotion: 'weary', starving: true };
      }
    }

    const addressing = resolveAddressing(input.persona, input.rel.affinity);
    const prompt = buildOraclePrompt(input, addressing);
    const result = await this.o.provider.complete({ prompt, system: SYSTEM, temperature: this.o.temperature });

    const parsed = parseAgentIntent(result.text);
    const intent = parsed.ok && parsed.intent ? parsed.intent : { say: undefined, effects: [] as Effect[], emotion: 'confused' };
    return {
      say: intent.say?.trim() ? intent.say.trim() : null,
      effects: intent.effects ?? [],
      gccCost: result.usage?.gccCost ?? 0,
      emotion: intent.emotion,
      attestation: result.attestation,
    };
  }
}

function buildOraclePrompt(input: OracleInput, addressing: string): string {
  const p = input.persona;
  const lines: string[] = [];
  lines.push(`你是 ${p.name}，${p.role}。`);
  lines.push(`你称呼这位访客为「${addressing}」（好感 ${input.rel.affinity}${input.rel.tags.length ? `，印象：${input.rel.tags.join('、')}` : ''}）。`);
  lines.push(`访客对你说：「${input.text}」`);
  lines.push('');
  lines.push('请只输出一个 JSON 对象，字段：');
  lines.push('- say: 你的一句中文对白');
  lines.push('- effects: 数组，可选。{"kind":"adjustRelationship","delta":整数(-20~20),"reason":"原因"} 或 {"kind":"setFlag","flag":"字符串","value":数字}');
  lines.push('- emotion: 你此刻的情绪（可选）');
  return lines.join('\n');
}
