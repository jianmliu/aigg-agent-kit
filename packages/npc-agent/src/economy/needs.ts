/**
 * Needs — per-NPC multi-axis 0..100 scalars (食/醉/眠/群/…). High = satisfied,
 * low = lacking. This is the input-half of the requirement layer: a hungry,
 * three-days-sober, lonely, stone-god-fearing dwarf differentiates its behaviour
 * because the LLM *reads these needs and reasons*, not because we wrote if-else.
 *
 * Pure + engine-neutral, zero deps. The host injects axes/rates/satisfy tables
 * from WorldDef; SharedWorld stores/reads the state, tickNeeds decays + satisfies
 * by room, and talk() summarizes the lacking axes into the prompt. Same shape as
 * metabolism.ts (灵力 = "能不能想", 需求 = "想什么").
 */

/** 每 NPC 几条 0..100 标量;高=满足,低=匮乏。纯可序列化、plain interface(同 MetabolismConfig 范式,无 class state)。 */
export interface NeedsState { [axis: string]: number }

/** 一轴的衰减/阈值声明(WorldDef.needs.axes 的值形)。 */
export interface NeedsAxis { decayPerTick: number; threshold?: number }

/** needs 配置:轴表 + 房间满足表(= WorldDef.needs 的运行时形)。 */
export interface NeedsConfig {
  axes: Record<string, NeedsAxis>;
  /** room id → { axis: amountPerTick };在某房间每 tick 满足哪些轴。 */
  satisfy: Record<string, Record<string, number>>;
}

const clamp = (n: number) => (n < 0 ? 0 : n > 100 ? 100 : n);

/** 衰减一步:每轴 -= decayPerTick * dt,clamp 0。返回**新对象**(纯,不改入参)。
 *  未在 state 但在 rates 里的轴以 100 起算(新轴默认满足)。 */
export function decayNeeds(s: NeedsState, rates: Record<string, NeedsAxis>, dt = 1): NeedsState {
  const out: NeedsState = { ...s };
  for (const [axis, r] of Object.entries(rates)) {
    const cur = out[axis] ?? 100;
    out[axis] = clamp(cur - r.decayPerTick * dt);
  }
  return out;
}

/** 满足一轴:+= amount,clamp 100。返回新对象。 */
export function satisfy(s: NeedsState, axis: string, amount: number): NeedsState {
  return { ...s, [axis]: clamp((s[axis] ?? 100) + amount) };
}

/** 低于阈值的轴,按紧迫(值升序——最匮乏在前)排序。thr 是轴无 threshold 时的默认阈。 */
export function urgent(s: NeedsState, axes?: Record<string, NeedsAxis>, thr = 30): string[] {
  return Object.entries(s)
    .filter(([axis, v]) => v < (axes?.[axis]?.threshold ?? thr))
    .sort((a, b) => a[1] - b[1])
    .map(([axis]) => axis);
}

/** 轴名 → 匮乏短语(内联表,同 metabolism label 范式);表外轴回落「<轴>有些匮乏」。 */
const LACK_PHRASE: Record<string, string> = {
  食: '很饿', food: '很饿',
  醉: '好几天没下酒馆了', drink: '好几天没下酒馆了',
  眠: '困得睁不开眼', sleep: '困得睁不开眼',
  群: '好久没与人说话了',
  茶: '嘴里发淡想喝口茶',
  敬石神: '心里不安,该去拜拜石神了', reverence: '心里不安,该去拜拜石神了',
  矿: '手痒想下矿', mine: '手痒想下矿',
  knowledge: '想读点新东西', influence: '想多些声望'
};
/** 英文世界的形容词式匮乏短语(配 degree 前缀,如 "desperately hungry")。表外轴回落 "low on <axis>"。 */
const LACK_PHRASE_EN: Record<string, string> = {
  食: 'hungry', food: 'hungry',
  醉: 'parched', drink: 'parched',
  眠: 'exhausted', sleep: 'exhausted',
  群: 'starved for company',
  茶: 'thirsty',
  敬石神: 'spiritually restless', reverence: 'spiritually restless',
  矿: 'restless to swing a pick', mine: 'restless to swing a pick',
  energy: 'drained', knowledge: 'starved for new ideas', influence: 'short on standing'
};

/** → prompt 行,如「你现在很饿,也好几天没下酒馆了」/ "desperately hungry, somewhat parched";
 *  全足时返回 ''(talk 据此跳过注入)。lang='en' → 英文(形容词式 degree+phrase),否则中文。 */
export function summarizeNeeds(s: NeedsState, axes?: Record<string, NeedsAxis>, thr = 30, lang: 'zh' | 'en' = 'zh'): string {
  const lacking = urgent(s, axes, thr);
  if (!lacking.length) return '';
  const parts = lacking.map((axis) => {
    const v = s[axis] ?? 100;
    if (lang === 'en') {
      const degree = v < 10 ? 'desperately ' : v < 20 ? 'badly ' : 'somewhat ';
      return `${degree}${LACK_PHRASE_EN[axis] ?? `low on ${axis}`}`;
    }
    const degree = v < 10 ? '已经' : v < 20 ? '很' : '有些';
    return `${degree}${LACK_PHRASE[axis] ?? `${axis}有些匮乏`}`;
  });
  return parts.join(lang === 'en' ? ', ' : ',');
}

/** 「无 def 时一组默认」(= DEFAULT_METABOLISM 范式):一组通用轴 + 空 satisfy。
 *  host 未声明 needs 时 SharedWorld 落它,保证 tickNeeds/summarize 行为可控:
 *  纯衰减、注入对应行,绝不报错、绝不动经济。 */
export const DEFAULT_NEEDS_CONFIG: NeedsConfig = {
  axes: {
    食: { decayPerTick: 2, threshold: 30 },
    眠: { decayPerTick: 1, threshold: 30 },
    群: { decayPerTick: 1.5, threshold: 30 }
  },
  satisfy: {}
};
