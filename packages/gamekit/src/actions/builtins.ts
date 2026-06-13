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
 * builtinActions — the 5 收编 operators. `marketRoom` (when given) gates trade
 * to the granary room, matching FairTick's `atMarket`. P1 default: all 5
 * registered; the world's opt-in switch decides whether the loop runs at all.
 */
export function builtinActions(opts: { marketRoom?: string } = {}): WorldAction[] {
  const marketRoom = opts.marketRoom;

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

  return [move, say, trade, pitch, give];
}
