import type { ReplayPack } from './schema';
import { corePack } from './packs/core';
import { townPack } from './packs/town';
import { econPack } from './packs/econ';

export class PackRegistry {
  private packs = new Map<string, ReplayPack>();

  register(pack: ReplayPack): this {
    this.packs.set(pack.id, pack);
    return this;
  }

  get(id: string): ReplayPack | undefined {
    return this.packs.get(id);
  }

  has(id: string): boolean {
    return this.packs.has(id);
  }

  /** Union of event kinds declared by the given pack ids (unknown ids ignored). */
  eventKinds(ids: string[]): Set<string> {
    const out = new Set<string>();
    for (const id of ids) for (const k of this.get(id)?.eventKinds ?? []) out.add(k);
    return out;
  }
}

/** A registry preloaded with the built-in core + town + econ packs. */
export function defaultRegistry(): PackRegistry {
  return new PackRegistry().register(corePack).register(townPack).register(econPack);
}
