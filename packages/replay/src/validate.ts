import { readFileSync } from 'node:fs';
import { SCHEMA_ID, type RunHeader, type Tick, type ValidateCtx } from './schema';
import { defaultRegistry, type PackRegistry } from './registry';
import { CORE_PACK_ID } from './packs/core';

export interface ValidateError { line: number; msg: string }
export interface ValidateResult { ok: boolean; errors: ValidateError[] }

/** Validate a run given as a line array or a raw multiline JSONL string. */
export function validateRun(
  input: string | string[],
  registry: PackRegistry = defaultRegistry(),
): ValidateResult {
  const errors: ValidateError[] = [];
  const fail = (line: number, msg: string) => errors.push({ line, msg });

  const raw = (Array.isArray(input) ? input : input.trim().split('\n')).filter((l) => l.length > 0);
  if (!raw.length) return { ok: false, errors: [{ line: 0, msg: 'empty run' }] };

  const objs = raw.map((l, i) => {
    try { return JSON.parse(l); } catch { fail(i + 1, 'invalid JSON'); return null; }
  });
  if (errors.length) return { ok: false, errors };

  // header
  const h = objs[0] as RunHeader;
  if (!h || h.kind !== 'run') { fail(1, 'line 1 must be kind:"run"'); return { ok: false, errors }; }
  if (h.schema !== SCHEMA_ID) fail(1, `unexpected schema ${String(h.schema)}`);
  for (const k of ['runId', 'packs', 'entities'] as const) if (!(k in h)) fail(1, `header missing ${k}`);
  if (!Array.isArray(h.entities) || !h.entities.length) fail(1, 'header.entities empty');
  for (const e of h.entities ?? []) for (const k of ['id', 'name']) if (!(k in e)) fail(1, `entity missing ${k}`);
  for (const p of h.packs ?? []) if (!registry.has(p)) fail(1, `unknown pack ${p}`);

  const ctx: ValidateCtx = { header: h, entityIds: new Set((h.entities ?? []).map((e) => e.id)) };
  const allowed = registry.eventKinds([CORE_PACK_ID, ...(h.packs ?? [])]);
  const declaredPacks = (h.packs ?? []).map((p) => registry.get(p)).filter((p): p is NonNullable<typeof p> => !!p);

  // body
  let prevT = -Infinity;
  for (let i = 1; i < objs.length; i++) {
    const o = objs[i] as { kind?: string; t?: number; events?: { kind: string }[] };
    const line = i + 1;
    const isLast = i === objs.length - 1;

    if (o.kind === 'summary') {
      if (!isLast) fail(line, 'summary must be the last line');
      continue;
    }
    if (o.kind !== 'tick') { fail(line, `expected tick, got ${String(o.kind)}`); continue; }
    if (typeof o.t !== 'number' || o.t <= prevT) fail(line, `tick t not strictly increasing (t=${String(o.t)})`);
    else prevT = o.t;

    for (const ev of o.events ?? []) {
      if (!allowed.has(ev.kind)) fail(line, `unknown event kind ${ev.kind}`);
      for (const pack of declaredPacks) for (const m of pack.validateEvent?.(ev, ctx) ?? []) fail(line, m);
    }
    for (const pack of declaredPacks) for (const m of pack.validateTick?.(o as Tick, ctx) ?? []) fail(line, m);
  }

  return { ok: errors.length === 0, errors };
}

/** Validate a run file on disk. */
export function validateFile(path: string, registry?: PackRegistry): ValidateResult {
  return validateRun(readFileSync(path, 'utf8'), registry);
}
