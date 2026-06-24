import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import {
  SCHEMA_ID, type RunHeader, type Event, type Tick, type Summary, type Entity, type WorldMap,
} from './schema';
import { defaultRegistry, type PackRegistry } from './registry';
import { CORE_PACK_ID } from './packs/core';

export interface RecorderOpts {
  /** Output JSONL path. Ignored if `write` is supplied. */
  path?: string;
  /** Custom line sink (e.g. a live tee). Overrides `path`. */
  write?: (line: string) => void;
  /** Declared DOMAIN packs (core is implicit). */
  packs: string[];
  registry?: PackRegistry;
}

export interface RunInit {
  runId: string;
  title?: string;
  createdAt?: number;
  entities: Entity[];
  map?: WorldMap;
  meta?: Record<string, unknown>;
}

export interface Recorder {
  run(init: RunInit): void;
  tick(t: number): void;
  event(kind: string, ev?: Omit<Event, 'kind'>): void;
  metrics(m: Record<string, number>): void;
  summary(s: Omit<Summary, 'kind'>): void;
  close(): void;
}

export function createRecorder(opts: RecorderOpts): Recorder {
  if (!opts.write && !opts.path) {
    throw new Error('recorder: supply either opts.path or opts.write');
  }
  const registry = opts.registry ?? defaultRegistry();
  const allowed = registry.eventKinds([CORE_PACK_ID, ...opts.packs]);

  let stream: WriteStream | undefined;
  const sink =
    opts.write ??
    ((line: string) => {
      if (!stream) {
        mkdirSync(dirname(opts.path!), { recursive: true });
        stream = createWriteStream(opts.path!, { flags: 'w' });
      }
      stream.write(line + '\n');
    });
  const writeObj = (o: unknown) => sink(JSON.stringify(o));

  let cur: Tick | null = null;
  let closed = false;
  const flush = () => { if (cur) { writeObj(cur); cur = null; } };

  return {
    run(init) {
      if (closed) throw new Error('recorder: already closed');
      const header: RunHeader = {
        kind: 'run', schema: SCHEMA_ID,
        runId: init.runId, title: init.title, createdAt: init.createdAt ?? 0,
        packs: opts.packs, entities: init.entities, map: init.map, meta: init.meta,
      };
      writeObj(header);
    },
    tick(t) { if (closed) throw new Error('recorder: already closed'); flush(); cur = { kind: 'tick', t, events: [] }; },
    event(kind, ev = {}) {
      if (!allowed.has(kind)) {
        throw new Error(`recorder: undeclared event kind "${kind}" (declared packs: ${opts.packs.join(',') || '(none)'})`);
      }
      if (!cur) throw new Error('recorder: event() called before tick()');
      cur.events.push({ kind, ...ev });
    },
    metrics(m) {
      if (!cur) throw new Error('recorder: metrics() called before tick()');
      cur.metrics = { ...(cur.metrics ?? {}), ...m };
    },
    summary(s) { if (closed) throw new Error('recorder: already closed'); flush(); writeObj({ kind: 'summary', ...s }); },
    close() { flush(); stream?.end(); closed = true; },
  };
}
