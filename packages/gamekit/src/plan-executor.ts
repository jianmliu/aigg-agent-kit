/**
 * PlanExecutor — the missing middle between aigg-memory's `plan` (intentions,
 * never executed by the kernel) and the room world (the execution substrate).
 * Closes the last of the five cognition ops into live play.
 *
 *   Dream-time: goal → world.plan() (ONE LLM pass) → kind=plan memory units
 *   Every tick (all deterministic, zero LLM):
 *     resolve the current step against THREE tables — NPC names (live roster),
 *     room aliases, (host-supplied) known places; a step naming a PERSON
 *     targets their CURRENT room (「找到对方」);
 *     not co-located → one BFS hop along the room graph per tick;
 *     co-located    → talk to them (the existing NPC↔NPC primitive);
 *     unresolvable  → skip, surfaced as an event (never lets model wording
 *                     wedge the executor — the discernment-match philosophy).
 *
 * Steps come from planSteps() (the plan units, stale ones auto-excluded — the
 * deterministic re-plan trigger) or are injected (scripted protagonists /
 * tests). One action per tick; the host narrates events into its feed.
 */
import type { SharedWorld } from './shared-world';

export interface PlanExecutorOptions {
  npcId: string;
  /** adjacency: roomId → walkable neighbor roomIds */
  roomGraph: Record<string, string[]>;
  /** place matching: roomId → human aliases (e.g. scene:6 → ['药铺']) */
  roomAliases?: Record<string, string[]>;
  /** injected steps (scripted/tests); else planSteps() is consulted */
  steps?: string[];
  /** the opener line when talking (default: 把步骤当话头) */
  greet?: (targetName: string, step: string) => string;
}

export type PlanAction =
  | { kind: 'move'; step: string; from: string; to: string; targetRoom: string }
  | { kind: 'talk'; step: string; room: string; targetId: string; targetName: string; said: string | null }
  | { kind: 'arrive'; step: string; room: string }
  | { kind: 'skip'; step: string; reason: 'unresolved' | 'unreachable' }
  | { kind: 'idle' };

interface Step { slug?: string; text: string }

/** BFS next hop from → to on the room graph; null = unreachable. */
export function nextHop(graph: Record<string, string[]>, from: string, to: string): string | null {
  if (from === to) return null;
  const prev = new Map<string, string>([[from, '']]);
  const q = [from];
  while (q.length) {
    const cur = q.shift()!;
    for (const nb of graph[cur] ?? []) {
      if (prev.has(nb)) continue;
      prev.set(nb, cur);
      if (nb === to) {
        let hop = to;
        while (prev.get(hop) !== from) hop = prev.get(hop)!;
        return hop;
      }
      q.push(nb);
    }
  }
  return null;
}

export class PlanExecutor {
  private queue: Step[] | null = null;
  private current: Step | null = null;

  constructor(private readonly world: SharedWorld, private readonly opts: PlanExecutorOptions) {
    if (opts.steps) this.queue = opts.steps.map((text) => ({ text }));
  }

  /** (re)load the queue from the NPC's plan units (post-Dream refresh). */
  async loadFromMemory(): Promise<number> {
    const steps = await this.world.planSteps(this.opts.npcId);
    this.queue = steps;
    return steps.length;
  }

  /** queue length (current step excluded) — 0 + no current = idle. */
  pending(): number {
    return (this.queue?.length ?? 0) + (this.current ? 1 : 0);
  }

  async runTick(): Promise<PlanAction> {
    // player/NPC directives (goto 算子) preempt: a fresh「去客栈」leads the queue,
    // ahead of any standing plan and even the half-done current step.
    const directives = this.world.takeGoto(this.opts.npcId);
    if (directives.length) {
      if (this.queue === null) this.queue = [];
      if (this.current) { this.queue.unshift(this.current); this.current = null; }
      this.queue.unshift(...directives.map((text) => ({ text })));
    }
    if (!this.current) {
      if (this.queue === null) await this.loadFromMemory();
      this.current = this.queue!.shift() ?? null;
      if (!this.current) return { kind: 'idle' };
    }
    const step = this.current;
    const me = await this.world.getNpc(this.opts.npcId);
    if (!me) { this.current = null; return { kind: 'skip', step: step.text, reason: 'unresolved' }; }

    // 三表 resolution: person (longest live-roster name in the text) → their
    // CURRENT room; else place alias → room; else unresolved.
    const roster = (await this.world.listNpcs()).filter((n) => n.id !== this.opts.npcId);
    let person: { id: string; name: string; room: string } | null = null;
    for (const n of roster) {
      if (n.name.length >= 2 && step.text.includes(n.name)) {
        if (!person || n.name.length > person.name.length) person = { id: n.id, name: n.name, room: n.room };
      }
    }
    let targetRoom = person?.room ?? null;
    if (!targetRoom) {
      // 大小写不敏感:英文世界别名是小写,步骤文本/玩家输入常是 Title Case
      // (「Go to Town Hall」)。中文世界无大小写,行为不变。
      const hay = step.text.toLowerCase();
      for (const [roomId, aliases] of Object.entries(this.opts.roomAliases ?? {})) {
        if (aliases.some((a) => a.length >= 2 && hay.includes(a.toLowerCase()))) { targetRoom = roomId; break; }
      }
    }
    if (!targetRoom) {
      this.current = null;
      return { kind: 'skip', step: step.text, reason: 'unresolved' };
    }

    if (me.room !== targetRoom) {
      const hop = nextHop(this.opts.roomGraph, me.room, targetRoom);
      if (!hop) { this.current = null; return { kind: 'skip', step: step.text, reason: 'unreachable' }; }
      await this.world.place(this.opts.npcId, hop);
      return { kind: 'move', step: step.text, from: me.room, to: hop, targetRoom };
    }

    // ask around: arrived with intent but the step named no one — engage
    // whoever is here (you went to the market to ask, so ask). A vague or
    // half-translated plan still ends in a conversation, not loitering.
    const target = person ?? roster.filter((n) => n.room === me.room)
      .map((n) => ({ id: n.id, name: n.name, room: n.room }))[0] ?? null;

    if (target) {
      const greet = this.opts.greet?.(target.name, step.text) ?? `(向${target.name}打听)${step.text}`;
      const r = await this.world.talk({ npcId: target.id, visitorId: this.opts.npcId, text: greet });
      this.current = null;
      return { kind: 'talk', step: step.text, room: me.room, targetId: target.id, targetName: target.name, said: r.said };
    }

    this.current = null;
    return { kind: 'arrive', step: step.text, room: me.room };
  }
}
