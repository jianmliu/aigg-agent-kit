import { mulberry32 } from './luck';
import type { CombatStats, BattleRound, RestraintTable } from './combat-types';

export interface BattleParticipant { id: string; stats: CombatStats }
export interface BattleResult { rounds: BattleRound[]; winnerId: string; loserId: string }

const MAX_ROUNDS = 30;

/** 纯:mulberry32(seed) 跑所有掷点 + 套五灵相克。不读 now、不算经济。 */
export function resolveBattle(
  a: BattleParticipant, b: BattleParticipant, seed: number, restraint: RestraintTable
): BattleResult {
  const rng = mulberry32(seed);
  const hp: Record<string, number> = { [a.id]: a.stats.hp, [b.id]: b.stats.hp };
  const rounds: BattleRound[] = [];
  // 先后手:武力高者先(并列 a 先)—— 确定性
  const order: BattleParticipant[] = a.stats.atk >= b.stats.atk ? [a, b] : [b, a];

  for (let r = 0; r < MAX_ROUNDS; r++) {
    for (const actor of order) {
      const target = actor.id === a.id ? b : a;
      if (hp[actor.id] <= 0 || hp[target.id] <= 0) continue;
      const variance = 0.9 + rng() * 0.2;                                  // [0.9,1.1)
      const mult = restraint[actor.stats.element][target.stats.element];
      const raw = actor.stats.atk * variance * mult - target.stats.def * 0.5;
      const damage = Math.max(1, Math.round(raw));                         // 至少 1
      hp[target.id] = Math.max(0, hp[target.id] - damage);
      rounds.push({ actorId: actor.id, targetId: target.id, action: 'attack', element: actor.stats.element, damage, targetHpAfter: hp[target.id] });
      if (hp[target.id] <= 0) return { rounds, winnerId: actor.id, loserId: target.id };
    }
  }
  // 超时:残血高者胜(并列 a 胜)
  const winnerId = hp[a.id] >= hp[b.id] ? a.id : b.id;
  return { rounds, winnerId, loserId: winnerId === a.id ? b.id : a.id };
}
