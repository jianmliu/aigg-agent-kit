/**
 * replay@1 — the domain-neutral core types plus the Pack interface.
 * Domain specifics live in packs (see ./packs/*), never here.
 */

export const SCHEMA_ID = 'replay@1' as const;

/** A generic actor in the world (replaces the economics-specific "agent"). */
export interface Entity {
  id: string;
  name: string;
  kind?: string;
  tags?: string[];
}

export interface MapRoom { id: string; name: string }
export interface WorldMap { rooms: MapRoom[]; edges?: [string, string][] }

/** Line 1 of a run. */
export interface RunHeader {
  kind: 'run';
  schema: typeof SCHEMA_ID;
  runId: string;
  title?: string;
  /** Monotonic origin (tick or ms) — the producer's choice. */
  createdAt: number;
  /** Declared DOMAIN packs present in this run (core is implicit). */
  packs: string[];
  entities: Entity[];
  map?: WorldMap;
  meta?: Record<string, unknown>;
}

/** One thing that happened. `kind` is "<pack>.<name>" (or core "move"/"say"). */
export interface Event {
  kind: string;
  actor?: string;
  target?: string;
  room?: string;
  by?: string;
  data?: Record<string, unknown>;
}

export interface Tick {
  kind: 'tick';
  t: number;
  events: Event[];
  metrics?: Record<string, number>;
}

export interface Summary {
  kind: 'summary';
  packs?: string[];
  metrics?: Record<string, number>;
  /** Domain blocks, e.g. `town: {...}` — open by design. */
  [block: string]: unknown;
}

export type ReplayLine = RunHeader | Tick | Summary;

/** Passed to pack validators so they can cross-check against the header. */
export interface ValidateCtx {
  header: RunHeader;
  entityIds: Set<string>;
}

/** A data-only descriptor; the viewer maps `render` to a render function. */
export interface PanelSpec {
  id: string;
  title: string;
  render: string;
}

/** The reusable seam: a world plugs in here, the core stays put. */
export interface ReplayPack {
  id: string;
  eventKinds: string[];
  validateEvent?(ev: Event, ctx: ValidateCtx): string[];
  validateTick?(tick: Tick, ctx: ValidateCtx): string[];
  viewer?: { panels: PanelSpec[] };
}
