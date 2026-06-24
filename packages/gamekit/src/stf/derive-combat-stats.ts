import type { CombatStats } from './combat-types';
import { WUXING } from './combat-types';

/** FNV-1a 哈希(确定性)。 */
function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** scripted 兜底:background → 原型档 + 五灵。纯、可重放。TODO(owner): 调区间;LLM 模式由 oracle 覆盖。 */
export function deriveCombatStats(background: string): CombatStats {
  const h = hashStr(background);
  const archetype = h % 3;                      // 0 武夫 / 1 术士 / 2 凡人
  const element = WUXING[(h >>> 2) % 5];
  const base =
    archetype === 0 ? { maxHp: 120, atk: 18, def: 12, spirit: 4 } :
    archetype === 1 ? { maxHp: 80,  atk: 10, def: 6,  spirit: 16 } :
                      { maxHp: 60,  atk: 6,  def: 4,  spirit: 3 };
  return { ...base, hp: base.maxHp, element, skills: [] };
}
