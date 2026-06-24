/** 五灵 —— 经典仙剑(风雷水火土)。相克表服务端独占(客户端 legacy 引擎只有抗性,不实现相克)。 */
export type WuxingElement = '风' | '雷' | '水' | '火' | '土';
export const WUXING: WuxingElement[] = ['风', '雷', '水', '火', '土'];

export interface CombatStats {
  maxHp: number;
  hp: number;              // 当前;重伤后 < maxHp
  atk: number;             // 武力
  def: number;             // 体魄(减伤)
  spirit: number;          // 灵力(v1 普攻未用,前向兼容仙术)
  element: WuxingElement;
  skills: string[];        // 会的仙术(v1 未用)
  woundedUntil?: number;   // 重伤期截止 tick
}

export interface BattleRound {
  actorId: string;
  targetId: string;
  action: 'attack' | { skill: string };
  element?: WuxingElement;
  damage: number;
  targetHpAfter: number;
}

/** 对手:NPC(持久,属性在 WorldState.combat)| 妖怪(临时,属性由 SharedWorld.hunt 解析后挂 tx)。 */
export type Combatant =
  | { kind: 'npc'; id: string }
  | { kind: 'monster'; species: string; stats: CombatStats };

/** restraint[攻击方属性][防御方属性] = 伤害倍率。 */
export type RestraintTable = Record<WuxingElement, Record<WuxingElement, number>>;

/** 占位相克表:同属性 0.9(本命抗性),其余 1.0。TODO(owner): 填真实五灵相生相克。 */
export const PLACEHOLDER_RESTRAINT: RestraintTable = WUXING.reduce((t, a) => {
  t[a] = WUXING.reduce((r, b) => { r[b] = a === b ? 0.9 : 1.0; return r; }, {} as Record<WuxingElement, number>);
  return t;
}, {} as RestraintTable);
