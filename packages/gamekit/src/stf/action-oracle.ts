/**
 * action-oracle — the AI boundary for the AGENT ACTION LOOP (spec §4.2 step 4).
 *
 * Parallel to InferenceOracle (which produces a talk's effects): ActionOracle
 * produces a CHOSEN ACTION — the NPC picks ONE operator from the offered menu.
 * This is the ONLY non-deterministic source in the loop (determinism 铁律):
 * the choice {actionId, args, say?} is a SIGNABLE turn input; resolve→applyTx
 * stays pure. LlmActionOracle captures the provider's Attestation the same way
 * LlmInferenceOracle does (provider proxy), so the choice is committable.
 *
 * ScriptedActionOracle lets smokes pin the choice (fixed/rotating) so the
 * 选→校验→resolve→STF chain runs with zero LLM, fully replayable (教训 A/E).
 */
import { parseActionChoice } from '@onchainpal/npc-agent';
import type { InferenceProvider, InferenceResult, Attestation } from '@onchainpal/npc-agent';
import type { ActionContext, ChosenAction } from '../actions/registry';

export interface ActionOracleInput {
  ctx: ActionContext;
  /** the available action menu (only available actions) rendered for the LLM. */
  schemas: Array<{ id: string; description: string; params: Record<string, unknown> }>;
}

export interface ActionOracleOutput extends ChosenAction {
  /** provider signature over prompt+response+model — committable provenance. */
  attestation?: Attestation;
}

export interface ActionOracle {
  chooseAction(input: ActionOracleInput): Promise<ActionOracleOutput>;
}

export interface LlmActionOracleOptions {
  provider: InferenceProvider;
  temperature?: number;
}

/** Render the choice prompt. Pure string assembly; the only IO is provider.complete. */
function buildChoicePrompt(input: ActionOracleInput): { system: string; prompt: string } {
  const { ctx, schemas } = input;
  const en = ctx.persona.language === 'en';
  const who = `${ctx.persona.name}${ctx.persona.role ? `,${ctx.persona.role.split('\n')[0].slice(0, 100)}` : ''}`;
  const present = ctx.npcsInRoom.map((n) => `${n.name}(${n.id})`).join('、') || (en ? 'no one' : '无人');
  const menu = schemas.map((s) => `- ${s.id}: ${s.description}\n  params: ${JSON.stringify(s.params)}`).join('\n');
  const system = en
    ? 'You are an autonomous game NPC choosing ONE action this turn. Output STRICTLY one JSON object, no explanation.'
    : '你是一个自主行动的游戏 NPC,这一回合要选择恰好一个行动。严格只输出一个 JSON 对象,不要解释。';
  const lines: string[] = [];
  lines.push(en ? `You are ${who}.` : `你是 ${who}。`);
  lines.push(en ? `You are at ${ctx.room}. Present: ${present}.` : `你在 ${ctx.room}。在场:${present}。`);
  lines.push(en
    ? `Your silver: ${ctx.balanceSilver}, GCC: ${ctx.balanceGcc}${ctx.ricePrice != null ? `, rice price: ${ctx.ricePrice}` : ''}.`
    : `你有银两 ${ctx.balanceSilver},灵力(GCC)${ctx.balanceGcc}${ctx.ricePrice != null ? `,米价 ${ctx.ricePrice}` : ''}。`);
  lines.push('');
  lines.push(en ? 'Available actions this turn:' : '本回合可选的行动:');
  lines.push(menu);
  lines.push('');
  lines.push(en
    ? 'Choose ONE. Output: {"actionId":"<id>","args":{...},"say":"<optional line>"}'
    : '选其中一个。输出:{"actionId":"<id>","args":{...},"say":"<可选的一句话>"}');
  return { system, prompt: lines.join('\n') };
}

export class LlmActionOracle implements ActionOracle {
  constructor(private readonly o: LlmActionOracleOptions) {}

  async chooseAction(input: ActionOracleInput): Promise<ActionOracleOutput> {
    const knownIds = input.schemas.map((s) => s.id);
    // empty menu → nothing to choose; degrade to a no-op-ish say fallback (resolve
    // will produce no op when no target). Never throws.
    if (!knownIds.length) return { actionId: 'say', args: {}, fellBack: true } as ActionOracleOutput;

    let captured: InferenceResult | undefined;
    const base = this.o.provider;
    const proxy: InferenceProvider = { id: base.id, complete: async (req) => { const r = await base.complete(req); captured = r; return r; } };

    const { system, prompt } = buildChoicePrompt(input);
    const result = await proxy.complete({ prompt, system, temperature: this.o.temperature ?? 0.6 });
    const choice = parseActionChoice(result.text, knownIds);
    return { ...choice, attestation: captured?.attestation };
  }
}

/**
 * ScriptedActionOracle — smokes inject this for a deterministic, zero-LLM choice.
 * Either a fixed choice, or a rotating list (one per call, cycling). `say` is
 * optional per choice. Records call count so a smoke can assert ≤1 call/tick (教训 B).
 */
export class ScriptedActionOracle implements ActionOracle {
  calls = 0;
  private i = 0;
  constructor(private readonly script: ChosenAction[]) {}
  async chooseAction(_input: ActionOracleInput): Promise<ActionOracleOutput> {
    this.calls++;
    const choice = this.script[this.i % this.script.length];
    this.i++;
    return { ...choice };
  }
}
