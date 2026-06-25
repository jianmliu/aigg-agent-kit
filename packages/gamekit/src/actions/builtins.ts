/**
 * builtinActions — the 5 existing behaviors收编 as the registry's initial
 * entries (spec §4.1 / §5 P1). Each maps to an EXISTING SharedWorld capability;
 * NO new economy is invented.
 *
 *   move  (=goto)   → world.pushGoto(npcId, place)         一跳/tick by the PlanExecutor
 *   say   (=talk)   → world.talk({npcId, visitorId, text}) the full oracle→STF→emit→overhear leg
 *   trade (=米市)    → world.tradeRice({npcId, side, amount})  银两 leg, applyTx(type:trade)
 *   pitch (=行骗)    → world.pitch({npcId:target, fromId:self, …})  victim gated BY memory
 *   give  (=转银两)  → world.transferSilver(self, target, amount)   atomic + silverTransferred emit
 *
 * available() is pure over the assembled ctx (determinism 铁律 / 教训 E).
 */
import type { WorldAction, ActionContext, ActionResolveOut } from './registry';
import { mulberry32 } from '../stf/luck';

/** narrow an unknown args object to a record for safe field reads. */
function obj(args: unknown): Record<string, unknown> {
  return (args && typeof args === 'object') ? (args as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * builtinActions — the P1 收编 5 + the P2 needs-driven 5 (spec §5 P2).
 *
 * `marketRoom` (when given) gates trade to the granary room, matching FairTick's
 * `atMarket`. The P2 `categories` map divides the world's needs.satisfy table
 * among recharge/research/socialize WITHOUT writing any axis name literal (轴名
 * 不写死, 教训 B): each of those 3 actions claims a CATEGORY = a set of axis names
 * spanning all worlds (PAL 茶/食/群 · 岩心堡 drink/reverence/food · Agentville
 * energy/knowledge/influence), and acts only on axes that are SIMULTANEOUSLY
 * (a) urgent, (b) in ctx.roomSatisfies (= this room can refill it), (c) in its
 * own category. That is the emergence闭环: 饿了在咖啡馆才能/才会选 recharge.
 *
 * P2 default mapping (consumption / knowledge / social) — override per WorldDef:
 *   recharge  → energy 食 food drink 醉 眠 sleep 矿 mine   (花银两 to a shopkeeper if present)
 *   research  → knowledge 茶 reverence 敬石神               (pure satisfyNeed, no/low silver)
 *   socialize → influence 群                                (satisfyNeed + affinity↑ to present NPC)
 *
 * `rechargeCost` = silver the recharge leg moves to a present shopkeeper (default 5;
 * degrades to a no-cost satisfyNeed when no other NPC is present — NEVER a negative
 * addSilver). `socialDelta`/`helpDelta`/`stealPenalty` size the affinity moves;
 * `helpAmount`/`stealMax` cap the silver transfers (always conserved + clamp≥0).
 * `caughtThreshold` (0..1) = steal's deterministic 被当场抓到 roll (mulberry32 of
 * ctx.now+ids — replayable, no Math.random). All registered; opt-in switch decides
 * whether the loop runs (默认关 → 零回归, 教训 C).
 */
export interface BuiltinActionsOpts {
  marketRoom?: string;
  /** action id → claimed axis names (its category). Defaults cover all 3 worlds. */
  categories?: { recharge?: string[]; research?: string[]; socialize?: string[] };
  /** per-action need top-up amount (default 30). */
  satisfyAmount?: number;
  rechargeCost?: number;
  socialDelta?: number;
  helpDelta?: number;
  helpAmount?: number;
  stealMax?: number;
  stealPenalty?: number;
  /** extra affinity drop when the thief is caught (default 8). */
  caughtPenalty?: number;
  /** P(被当场抓到) — deterministic roll vs this (default 0.25). */
  caughtThreshold?: number;
}

const DEFAULT_CATEGORIES: Required<NonNullable<BuiltinActionsOpts['categories']>> = {
  recharge: ['energy', '食', 'food', 'drink', '醉', '眠', 'sleep', '矿', 'mine'],
  research: ['knowledge', '茶', 'reverence', '敬石神'],
  socialize: ['influence', '群']
};

/** axes that are BOTH urgent (below threshold) AND refillable in this room AND in the action's category. */
function claimable(ctx: ActionContext, category: string[], thr = 30): string[] {
  const sat = ctx.roomSatisfies;
  if (!sat) return [];
  return category.filter((axis) => axis in sat && (ctx.needs[axis] ?? 100) < thr);
}

export function builtinActions(opts: BuiltinActionsOpts = {}): WorldAction[] {
  const marketRoom = opts.marketRoom;
  const cats = { ...DEFAULT_CATEGORIES, ...(opts.categories ?? {}) };
  const amt = opts.satisfyAmount ?? 30;
  const rechargeCost = opts.rechargeCost ?? 5;
  const socialDelta = opts.socialDelta ?? 5;
  const helpDelta = opts.helpDelta ?? 8;
  const helpAmount = opts.helpAmount ?? 10;
  const stealMax = opts.stealMax ?? 10;
  const stealPenalty = opts.stealPenalty ?? 12;
  const caughtPenalty = opts.caughtPenalty ?? 8;
  const caughtThreshold = opts.caughtThreshold ?? 0.25;

  const move: WorldAction = {
    id: 'move',
    // 自主移动:总有别处可去(下一 tick 由 PlanExecutor 一跳走)。
    available: () => true,
    schema: {
      description: '移动到某个地点(place 是地名或人名);下一拍开始一步步走过去。Move toward a place or person.',
      params: { type: 'object', properties: { place: { type: 'string', description: '目的地名/人名' } }, required: ['place'] }
    },
    resolve: (ctx: ActionContext, args: unknown): ActionResolveOut => {
      const place = str(obj(args).place) ?? '';
      return { effects: [], sharedWorldOp: place ? async (w) => w.pushGoto(ctx.npcId, place) : undefined };
    }
  };

  const say: WorldAction = {
    id: 'say',
    available: (ctx) => ctx.npcsInRoom.length > 0,
    schema: {
      description: '对在场的某人说话(targetId 必须是在场者的 id;text 是要说的话)。Speak to someone present.',
      params: {
        type: 'object',
        properties: {
          targetId: { type: 'string', description: '在场对话对象的 npc/玩家 id' },
          text: { type: 'string', description: '要说的一句话' }
        },
        required: ['targetId', 'text']
      }
    },
    resolve: (ctx: ActionContext, args: unknown): ActionResolveOut => {
      const a = obj(args);
      const targetId = str(a.targetId) ?? ctx.npcsInRoom[0]?.id ?? '';
      const text = str(a.text) ?? '';
      // text 直接用 chooseAction 的产出 —— talk() 内部自有一次 oracle.produce 产对方回应
      // (正常对话成本,同今天玩家 talk),仍每主动回合 ≤1 say 动作(成本封顶在 runActionTurn)。
      return {
        effects: [], say: text || undefined,
        sharedWorldOp: (targetId && text) ? async (w) => { await w.talk({ npcId: ctx.npcId, visitorId: targetId, text }); } : undefined
      };
    }
  };

  const trade: WorldAction = {
    id: 'trade',
    // 银两 leg:要有银两、有盘口、(可选)在市场房间。
    available: (ctx) =>
      ctx.balanceSilver > 0 && ctx.ricePrice != null && (!marketRoom || ctx.room === marketRoom),
    schema: {
      description: '在米行买/卖米(side=buy 用银两囤米 / sell 抛米换银两;amount 是投入量)。Trade rice at the granary.',
      params: {
        type: 'object',
        properties: {
          side: { type: 'string', enum: ['buy', 'sell'], description: 'buy=囤米 / sell=抛米' },
          amount: { type: 'number', description: '投入量(buy=银两 / sell=米)' }
        },
        required: ['side', 'amount']
      }
    },
    resolve: (ctx: ActionContext, args: unknown): ActionResolveOut => {
      const a = obj(args);
      const side = a.side === 'sell' ? 'sell' : 'buy';
      const amount = num(a.amount) ?? 0;
      return {
        effects: [],
        sharedWorldOp: amount > 0 ? async (w) => { await w.tradeRice({ npcId: ctx.npcId, side, amount }); } : undefined
      };
    }
  };

  const pitch: WorldAction = {
    id: 'pitch',
    // 发起者只需有在场目标(GCC 动的是 victim,不是发起者)。
    available: (ctx) => ctx.npcsInRoom.length > 0,
    schema: {
      description: '向在场的某人兜售一个提议/买卖(行骗:targetId 在场者 id,claim 说辞,amountGcc 涉及的 GCC)。Pitch a deal to someone present.',
      params: {
        type: 'object',
        properties: {
          targetId: { type: 'string', description: '被兜售对象的 id(在场者)' },
          claim: { type: 'string', description: '说辞' },
          amountGcc: { type: 'number', description: '提议涉及的 GCC' }
        },
        required: ['targetId', 'claim', 'amountGcc']
      }
    },
    resolve: (ctx: ActionContext, args: unknown): ActionResolveOut => {
      const a = obj(args);
      const targetId = str(a.targetId) ?? ctx.npcsInRoom[0]?.id ?? '';
      const claim = str(a.claim) ?? '一本万利,错过再无';
      const amountGcc = num(a.amountGcc) ?? 2;
      return {
        effects: [],
        sharedWorldOp: targetId
          ? async (w) => { await w.pitch({ npcId: targetId, fromId: ctx.npcId, amountGcc, claim }); }
          : undefined
      };
    }
  };

  const give: WorldAction = {
    id: 'give',
    available: (ctx) => ctx.balanceSilver > 0 && ctx.npcsInRoom.length > 0,
    schema: {
      description: '转给在场的某人一些银两(targetId 在场者 id,amount 银两数)。Give silver to someone present.',
      params: {
        type: 'object',
        properties: {
          targetId: { type: 'string', description: '收银两者 id(在场者)' },
          amount: { type: 'number', description: '银两数' }
        },
        required: ['targetId', 'amount']
      }
    },
    resolve: (ctx: ActionContext, args: unknown): ActionResolveOut => {
      const a = obj(args);
      const targetId = str(a.targetId) ?? ctx.npcsInRoom[0]?.id ?? '';
      const amount = num(a.amount) ?? 0;
      return {
        effects: [],
        sharedWorldOp: (targetId && amount > 0)
          ? async (w) => { await w.transferSilver(ctx.npcId, targetId, amount); }
          : undefined
      };
    }
  };

  // ───────────────────────── P2 需求驱动 + 新动作 (spec §5 P2) ─────────────────────────

  // recharge —— 满足 energy/食轴 (在家/充电站/咖啡馆,花银两)。门控:该轴匮乏 + 本房能回该轴。
  // resolve = satisfyNeed(claimed axis,+) + (有店主在场则)transferSilver(self→店主) 守恒;
  // 无店主 → 退化为 no-cost satisfyNeed(绝不负 addSilver)。轴名按 ctx.roomSatisfies,不写死。
  const recharge: WorldAction = {
    id: 'recharge',
    available: (ctx) => claimable(ctx, cats.recharge).length > 0,
    schema: {
      description: '在本地点补充体力/进食(花一点银两)。Refill energy/food here (costs a little silver).',
      params: { type: 'object', properties: {}, required: [] }
    },
    resolve: (ctx: ActionContext, _args: unknown): ActionResolveOut => {
      const axes = claimable(ctx, cats.recharge);
      // 店主 = 在场任一别的 NPC(有谁就付给谁;无人则免费回填,绝不凭空造/扣)。
      const shop = ctx.npcsInRoom[0]?.id;
      const willPay = !!shop && ctx.balanceSilver > 0 ? Math.min(rechargeCost, ctx.balanceSilver) : 0;
      return {
        effects: [], cost: willPay,
        sharedWorldOp: axes.length
          ? async (w) => {
              for (const axis of axes) await w.satisfyNeed(ctx.npcId, axis, amt);
              if (willPay > 0 && shop) await w.transferSilver(ctx.npcId, shop, willPay);  // 守恒 + clamp≥0
            }
          : undefined
      };
    }
  };

  // research —— 满足 knowledge 轴 (图书馆/书店/听书);纯 satisfyNeed,无/低银两。
  const research: WorldAction = {
    id: 'research',
    available: (ctx) => claimable(ctx, cats.research).length > 0,
    schema: {
      description: '在本地点读书/求知,长见识。Study here to satisfy your thirst for knowledge.',
      params: { type: 'object', properties: {}, required: [] }
    },
    resolve: (ctx: ActionContext, _args: unknown): ActionResolveOut => {
      const axes = claimable(ctx, cats.research);
      return {
        effects: [],
        sharedWorldOp: axes.length
          ? async (w) => { for (const axis of axes) await w.satisfyNeed(ctx.npcId, axis, amt); }
          : undefined
      };
    }
  };

  // socialize —— 满足 influence 轴 (广场/市政厅/告示板,与在场者社交) + 可选 adjustAffinity(+)。
  // 门控:本房能回 influence 类轴 + 该轴匮乏 + 同房有别的 NPC。
  const socialize: WorldAction = {
    id: 'socialize',
    available: (ctx) => ctx.npcsInRoom.length > 0 && claimable(ctx, cats.socialize).length > 0,
    schema: {
      description: '在本地点与在场的人社交,涨声望、增进交情。Mingle with people present to build standing.',
      params: { type: 'object', properties: { targetId: { type: 'string', description: '社交对象的 id(在场者,可选)' } }, required: [] }
    },
    resolve: (ctx: ActionContext, args: unknown): ActionResolveOut => {
      const axes = claimable(ctx, cats.socialize);
      const target = str(obj(args).targetId) ?? ctx.npcsInRoom[0]?.id;
      return {
        effects: [],
        sharedWorldOp: axes.length
          ? async (w) => {
              for (const axis of axes) await w.satisfyNeed(ctx.npcId, axis, amt);
              if (target) await w.adjustAffinity(ctx.npcId, target, socialDelta, ['socialized'], ctx.now);
            }
          : undefined
      };
    }
  };

  // help (正和合作) —— 给在场 NPC 银两/相助,双方好感↑。门控:同房有别的 NPC + 自己有银两。
  // resolve = transferSilver(self→target) 守恒 + adjustAffinity 双向 +。
  const help: WorldAction = {
    id: 'help',
    available: (ctx) => ctx.balanceSilver > 0 && ctx.npcsInRoom.length > 0,
    schema: {
      description: '帮助在场的某人(给点银两相助),双方交情加深(targetId 在场者 id,amount 银两)。Help someone present.',
      params: {
        type: 'object',
        properties: {
          targetId: { type: 'string', description: '受助者 id(在场者)' },
          amount: { type: 'number', description: '相助的银两数' }
        },
        required: ['targetId']
      }
    },
    resolve: (ctx: ActionContext, args: unknown): ActionResolveOut => {
      const a = obj(args);
      const target = str(a.targetId) ?? ctx.npcsInRoom[0]?.id ?? '';
      const amount = Math.min(num(a.amount) ?? helpAmount, ctx.balanceSilver);
      return {
        effects: [], cost: amount > 0 ? amount : 0,
        sharedWorldOp: target
          ? async (w) => {
              if (amount > 0) await w.transferSilver(ctx.npcId, target, amount);   // 守恒 + clamp≥0
              await w.adjustAffinity(ctx.npcId, target, helpDelta, ['helped'], ctx.now);
              await w.adjustAffinity(target, ctx.npcId, helpDelta, ['helped-by'], ctx.now);
            }
          : undefined
      };
    }
  };

  // steal (扒窃, §7 冲突) —— 偷在场 NPC 至多 N 银两;受害者好感↓ + 形成警惕信念(亲历级)
  // → 下次可被 discernment 识破;低概率「被当场抓到」(确定性 mulberry32(now+ids),加重好感↓)。
  // resolve = transferSilver(target→self,强制守恒) + adjustAffinity(victim,-) + rememberTheft。
  const steal: WorldAction = {
    id: 'steal',
    available: (ctx) => ctx.npcsInRoom.some((n) => n.balanceSilver > 0),
    schema: {
      description: '趁人不备扒窃在场某人的银两(targetId 在场者 id)。有被当场抓到的风险,得手者被记恨。Pickpocket someone present.',
      params: { type: 'object', properties: { targetId: { type: 'string', description: '行窃目标 id(在场且有银两)' } }, required: ['targetId'] }
    },
    resolve: (ctx: ActionContext, args: unknown): ActionResolveOut => {
      const a = obj(args);
      // 目标:指定优先,否则取在场首个有银两者。
      const named = str(a.targetId);
      const victim = ctx.npcsInRoom.find((n) => n.id === named && n.balanceSilver > 0)
        ?? ctx.npcsInRoom.find((n) => n.balanceSilver > 0);
      if (!victim) return { effects: [] };
      const take = Math.min(stealMax, victim.balanceSilver);
      // 被抓 = 确定性:mulberry32(hash(now, thief, victim)) < threshold(可重放,无 Math.random)。
      const seed = (Math.abs(hashIds(ctx.now, ctx.npcId, victim.id)) >>> 0);
      const caught = mulberry32(seed)() < caughtThreshold;
      const penalty = stealPenalty + (caught ? caughtPenalty : 0);
      return {
        effects: [], cost: 0,
        sharedWorldOp: take > 0
          ? async (w) => {
              await w.transferSilver(victim.id, ctx.npcId, take);    // 强制 victim→self,守恒 + clamp≥0
              await w.adjustAffinity(victim.id, ctx.npcId, -penalty, caught ? ['theft', 'caught'] : ['theft'], ctx.now);
              await w.rememberTheft(victim.id, ctx.npcId, take, ctx.now);   // 受害者亲历级警惕信念
            }
          : undefined
      };
    }
  };

  return [move, say, trade, pitch, give, recharge, research, socialize, help, steal, huntAction];
}

/** 在野外狩猎妖怪换取 ②层资源产出。needs 告急或带产出意图时浮现。 */
export const huntAction: WorldAction = {
  id: 'hunt',
  available(ctx) {
    if (!ctx.inWild) return false;
    if (ctx.productionIntent) return true;
    // 任一需求轴低于 30 视为"饿了"——轴名不写死
    return Object.values(ctx.needs ?? {}).some((v) => v < 30);
  },
  schema: {
    description: '在野外狩猎妖怪,以战斗换取资源产出',
    params: { type: 'object', properties: { species: { type: 'string' } } }
  },
  resolve(ctx, args) {
    const species = (args as { species?: string })?.species;
    return {
      effects: [],
      sharedWorldOp: (w) => w.hunt(ctx.npcId, species, ctx.now).then(() => undefined)
    };
  }
};

/** deterministic 32-bit hash of (now, thiefId, victimId) — seeds steal's 被抓 roll (replayable). */
function hashIds(now: number, a: string, b: string): number {
  let h = 2166136261 ^ (now | 0);
  const s = `${a}|${b}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h | 0;
}
