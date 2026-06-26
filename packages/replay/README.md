# @aigg/replay

Unified, pack-extensible replay for the ai.gg family. A domain-neutral core
(`replay@1`) plus a Pack Registry: a world registers a pack, and the recorder,
validator, and viewer all consult the same registry — the core never changes.

## Concepts

- **Core** — JSONL: a `run` header (`entities`, optional `map`, declared `packs`),
  ordered `tick` lines (`events[]`, optional flat `metrics`), an optional `summary`.
- **Pack** — `{ id, eventKinds, validateEvent?, validateTick?, viewer:{panels} }`.
  Built-ins: `core@0` (move/say), `town@0` (0gtown learn-loop), `econ@0` (stub).

## Use

```ts
import { createRecorder, validateFile } from '@aigg/replay';

const rec = createRecorder({ path: 'runs/run.jsonl', packs: ['town@0'] });
rec.run({ runId, entities, map, meta });
rec.tick(1);
rec.event('town.talk', { actor, target, data });
rec.summary({ town: { refusals: 0 } });
rec.close();

validateFile('runs/run.jsonl').ok; // → true
```

## Viewer

Static, zero-dependency. Serve `viewer/` (path via `viewerDir()`) and open
`index.html?run=<url-to-jsonl>`. Core panels always render; declared packs light
up their panels; unknown packs degrade to core-only.

## Tests

`pnpm --filter @aigg/replay test:scaffold|registry|town|econ|validate|recorder|fixture|viewer`
