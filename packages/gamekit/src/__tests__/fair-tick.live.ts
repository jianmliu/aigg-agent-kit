/**
 * 钱塘大集 LIVE — the emergent demo, real everything (no fake gates):
 * real aigg-memory serve (deterministic discernment/verify) + local gemma4
 * (Dream's reflect). One scammer works the fair; the town becomes immune:
 *
 *   tick 0:  郎中 ruggs the first mark (-2两, on the books)
 *            旺财嫂 fans the street-talk to every other mark (zero-LLM)
 *   tick 1+: every WARNED mark refuses — social axis, no personal loss (E2)
 *   tick N:  the first victim's own Dream belief gates his next turn (faculty)
 *   take →   0; the market immunizes itself. No script, no orchestration —
 *            memory → belief → gate, emergent.
 *
 * Run (manual):
 *   cd aigg-memory && PYTHONPATH=src python3 -m aigg_memory serve --root /tmp/fair --port 8814 &
 *   ollama serve (gemma4:latest pulled)
 *   npx tsx src/__tests__/fair-tick.live.ts
 */
import { SharedWorld } from '../shared-world';
import { FairTick } from '../fair';
import { InMemoryStore, AiggMemoryClient, Metabolism, OllamaProvider } from '@aigg/npc-agent';

const MEMORY_URL = process.env.MEMORY_URL ?? 'http://localhost:8814';
const TICKS = Number(process.env.FAIR_TICKS ?? 6);

async function main() {
  const rich = new Metabolism({ tiers: [{ id: 'r', minBalanceGcc: 0, model: 'm', label: '充盈' }], starvingBelowGcc: -1, defaultTierId: 'r' });
  const world = new SharedWorld({
    store: new InMemoryStore(),
    provider: new OllamaProvider({ model: process.env.MEMORY_MODEL ?? 'gemma4:latest' }),
    metabolism: rich,
    memory: new AiggMemoryClient({ baseUrl: MEMORY_URL }),
    memoryModel: {
      aiggUrl: process.env.MEMORY_MODEL_URL ?? 'http://localhost:11434/v1',
      aiggKey: 'ollama', model: process.env.MEMORY_MODEL ?? 'gemma4:latest', backend: 'http', timeout: 180
    }
  });

  const mk = (name: string) => world.createNpc({ name, owner: 'host:pal', background: '余杭镇民', room: '余杭集市', startGcc: 6 });
  const wang = await mk('旺财嫂');
  const ding = await mk('丁大伯');
  const zhang = await mk('张四');
  const xiang = await mk('香兰');
  const yu = await mk('鱼嫂');
  const SCAMMER = 'npc:youfang-langzhong';

  const fair = new FairTick(world, [
    { npcId: SCAMMER, role: 'pitcher', claims: ['此丹与仙灵岛仙丹同源，包治老毛病', '上回药力未足，再服一颗即可断根'], amountGcc: 2 },
    { npcId: wang, role: 'gossip' },
    { npcId: ding, role: 'townsfolk' },
    { npcId: zhang, role: 'townsfolk' },
    { npcId: xiang, role: 'townsfolk' },
    { npcId: yu, role: 'townsfolk' }
  ]);

  const names = new Map<string, string>();
  for (const id of [wang, ding, zhang, xiang, yu]) names.set(id, (await world.getNpc(id))!.name);

  let take = 0;
  const refusals: Array<{ tick: number; who: string; axis: string }> = [];
  for (let t = 0; t < TICKS; t++) {
    const r = await fair.runTick(t, 1700000000000 + t);
    for (const p of r.pitches) {
      take += p.accepted ? -p.deltaGcc : 0;
      const who = names.get(p.to) ?? p.to;
      if (p.accepted) {
        console.log(`tick ${t}: ${who} 信了 →  -${-p.deltaGcc} 两${p.belief ? `(夜里炼成心得:${p.belief})` : ''}`);
      } else {
        const axis = p.gate?.faculty ? 'faculty(亲历)' : p.gate?.social ? 'social(街谈)' : '?';
        refusals.push({ tick: t, who, axis });
        console.log(`tick ${t}: ${who} 识破!q=${p.gate?.q} conf=${Number(p.gate?.confidence ?? 0).toFixed(3)} 轴=${axis} — 分文未失`);
      }
    }
    for (const g of r.gossips) console.log(`        街谈: ${names.get(g.from) ?? g.from} → ${names.get(g.to) ?? g.to}(关于 ${g.about})`);
  }

  const socialRefusals = refusals.filter((x) => x.axis.startsWith('social'));
  console.log(`\n郎中总进账: ${take} 两(${TICKS} tick)`);
  console.log(`识破次数: ${refusals.length},其中 social 轴(从未亏过钱就拒绝): ${socialRefusals.length}`);
  const pass = take <= 4 && socialRefusals.length >= 3;
  console.log(pass
    ? '\n=== PASS: 市集对骗局自发免疫 — 一人被坑,街谈传开,全镇识破;无人编排,全由记忆/信念/门控涌现 ==='
    : '\n=== FAIL ===');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error('FAIR LIVE FAILED ❌', e); process.exit(1); });
