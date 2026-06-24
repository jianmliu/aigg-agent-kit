import type { WuxingElement } from './combat-types';

export interface DropTable {
  silver?: [number, number];  // [min, max] 银两掉落范围
  food?: [number, number];    // [min, max] 食物掉落范围
}

export interface MonsterSpecies {
  id: string;                  // '林中野狼'
  maxHp: number;
  atk: number;
  def: number;
  spirit: number;
  element: WuxingElement;
  skills?: string[];
  drops: DropTable;
}

export interface WildConfig {
  rooms: string[];                                                    // 标 wild 的房间 id
  bestiary: MonsterSpecies[];
  spawns: Record<string, Array<{ species: string; weight: number }>>; // room → 遭遇权重表
}
