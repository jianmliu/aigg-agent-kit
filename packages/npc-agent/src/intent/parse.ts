import { z } from 'zod';
import type { AgentIntent } from './agent-intent';

/**
 * Schema for validating UNTRUSTED LLM output into an AgentIntent. The model is
 * asked to emit JSON; we tolerate ```json fences and extra prose, then validate.
 * Unknown effect kinds are dropped (not thrown) so one bad effect doesn't void
 * the whole reply. Effects still get re-validated against GameRules downstream.
 */
const effectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('adjustRelationship'), delta: z.number(), reason: z.string() }),
  z.object({ kind: z.literal('setFlag'), flag: z.string(), value: z.number() }),
  z.object({ kind: z.literal('giveItem'), itemId: z.number(), qty: z.number() }),
  z.object({ kind: z.literal('takeItem'), itemId: z.number(), qty: z.number() }),
  z.object({ kind: z.literal('startQuest'), questId: z.string() }),
  z.object({ kind: z.literal('advanceQuest'), questId: z.string(), step: z.string() }),
  z.object({ kind: z.literal('goto'), place: z.string() })
]);

const memoryEntrySchema = z.object({
  tier: z.enum(['working', 'episodic', 'semantic', 'relationship']),
  text: z.string(),
  salience: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional()
});

const intentSchema = z.object({
  say: z.string().optional(),
  // tolerate malformed individual effects: keep the valid ones, drop the rest
  effects: z.array(z.unknown()).optional(),
  memoryWrites: z.array(memoryEntrySchema).optional(),
  emotion: z.string().optional()
});

export interface ParseResult {
  ok: boolean;
  intent?: AgentIntent;
  error?: string;
  /** effects that were present but failed schema validation (for logging). */
  droppedEffects?: unknown[];
}

/** Strip ```json fences / surrounding prose and return the first JSON object. */
function extractJson(raw: string): string | null {
  if (!raw) return null;
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  return s.slice(start, end + 1);
}

export function parseAgentIntent(raw: string): ParseResult {
  const json = extractJson(raw);
  if (!json) {
    return { ok: false, error: 'no JSON object found in model output' };
  }
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (err) {
    return { ok: false, error: `JSON parse failed: ${(err as Error).message}` };
  }
  const base = intentSchema.safeParse(obj);
  if (!base.success) {
    return { ok: false, error: base.error.message };
  }
  const dropped: unknown[] = [];
  const effects = (base.data.effects ?? []).flatMap((e) => {
    const parsed = effectSchema.safeParse(e);
    if (parsed.success) return [parsed.data];
    dropped.push(e);
    return [];
  });
  const intent: AgentIntent = {
    say: base.data.say,
    effects,
    memoryWrites: base.data.memoryWrites,
    emotion: base.data.emotion
  };
  return { ok: true, intent, droppedEffects: dropped.length ? dropped : undefined };
}

/**
 * Action-loop choice parser (agent-action-loop.md §4.4 / determinism).
 * The LLM is asked to pick ONE action from the offered menu and emit
 *   {"actionId":"say","args":{...},"say":"..."}
 * We tolerate ```json fences + prose (extractJson), validate the envelope, and
 * — crucially — NEVER let model wording wedge the turn (PlanExecutor 范式):
 *   - no JSON / bad shape / unknown actionId → FALL BACK to a known action
 *     (prefer 'say' if offered, else the first known id), with empty args.
 * `args` stays an opaque object; each WorldAction.resolve narrows its own fields
 * (so one malformed arg degrades inside resolve, never throws here).
 */
const choiceSchema = z.object({
  actionId: z.string().optional(),
  action: z.string().optional(),   // tolerate the model naming the field `action`
  args: z.record(z.unknown()).optional(),
  say: z.string().optional()
});

export interface ActionChoice {
  actionId: string;
  args: Record<string, unknown>;
  say?: string;
  /** true when we had to fall back (unknown/missing id or unparseable output). */
  fellBack: boolean;
}

export function parseActionChoice(raw: string, knownIds: string[]): ActionChoice {
  const fallbackId = knownIds.includes('say') ? 'say' : (knownIds[0] ?? 'say');
  const fallback = (say?: string): ActionChoice => ({ actionId: fallbackId, args: {}, fellBack: true, ...(say ? { say } : {}) });

  const json = extractJson(raw);
  if (!json) return fallback();
  let obj: unknown;
  try { obj = JSON.parse(json); } catch { return fallback(); }
  const parsed = choiceSchema.safeParse(obj);
  if (!parsed.success) return fallback();

  const id = parsed.data.actionId ?? parsed.data.action;
  const say = parsed.data.say?.trim() ? parsed.data.say.trim() : undefined;
  const args = parsed.data.args ?? {};
  if (!id || !knownIds.includes(id)) return fallback(say);
  return { actionId: id, args, fellBack: false, ...(say ? { say } : {}) };
}
