# @aigg/cognition

Agent social cognition over the external [aigg-memory](https://github.com/jianmliu/aigg-memory) service.
A `MemoryKernel` port (memory→belief→reflection), per-peer **trust**, and **warning
diffusion** — one NPC learns a scam and warns another, who then refuses it unburned.

## Concepts

- **`MemoryKernel`** — the aigg-memory subset cognition uses. `AiggMemoryKernel` hits
  the HTTP service; `FakeKernel` is an in-memory backend for tests/offline. Everything
  except `reflect` is **model-free**.
- **`Cognition`** — `recall(self, peer, topic)` (pre-hook: beliefs + trust + a prompt
  summary), `learn(self, peer, episode)` (post-hook: record + form a belief on a loss +
  drop peer trust), `warn(from, to, topic)` (diffuse a warning), `reflect(self)` (LLM).
- **`TrustLedger`** — per-`(self,peer)` trust in `[-1,1]`.
- **`shouldRefuse(signal)`** — deterministic belief/trust gate for pitch-like decisions.

## Use

```ts
import { Cognition, TrustLedger, AiggMemoryKernel, FakeKernel, shouldRefuse } from '@aigg/cognition';

const kernel = process.env.MEMORY_URL ? new AiggMemoryKernel({ baseUrl: process.env.MEMORY_URL }) : new FakeKernel();
const cog = new Cognition(kernel, new TrustLedger());

const sig = await cog.recall('npc:abao', 'visitor:1', 'elixir');     // pre
if (shouldRefuse(sig).refuse) { /* deterministic refusal */ }
await cog.learn('npc:abao', 'visitor:1', { topic: 'elixir', description: '…lost 3 $0G', outcome: 'loss' });  // post
await cog.warn('npc:abao', 'npc:liu', 'elixir');                     // social
```

Two invariants (validated against aigg-memory): discernment runs in `mode:'text'`, and
`remember`'s fields are nested inside the request `payload`.

## Tests

`pnpm --filter @aigg/cognition test:{scaffold,id,fake,trust,warn,gate,cognition,aigg}`
