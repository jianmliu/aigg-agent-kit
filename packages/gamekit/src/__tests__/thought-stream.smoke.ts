/**
 * Headless smoke: P1 of the persistent thought stream (docs/specs/persistent-thought-stream.md).
 * 每个 NPC 一条 append-only 的第一人称思绪流;P1 只写 observation,来自两个注入点:
 *   ① talk()   —— 对方说的话落进【被搭话的 NPC】的流(talk 从「会话入口」降级为「注入点」)
 *   ② overhear —— 旁听到的话落进【听众自己】的流
 * 证明:
 *   1. 注入点①:被搭话的 NPC 轨迹有 src='talk' 的观察,text/from/room 正确
 *   2. 注入点②:同房听众轨迹有 src='overhear' 的观察,from=说话者
 *   3. 作用域不串味:听众的流里【没有】玩家那句 talk;说话者的流里【没有】overhear 条目
 *   4. ★ 与记忆闸相反:starving 听众【仍然】记录轨迹(纯 store 写,零成本;昏睡时世界照常发生,
 *      醒来应知错过了什么 —— §4.3 dormant 语义)。对照:它没有 episodic remember(既有行为不变)
 *   5. 异房不记录
 *   6. append-only 累积 + trajectory(limit) 取最近 n
 *   7. 不阻塞:talk() 返回时①已落定(await),②随 fire-and-forget 稍后到达
 *
 * Run: pnpm --filter @aigg/gamekit test:traj
 */
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { AiggMemoryClient } from '@aigg/npc-agent';
import { InMemoryStore, Metabolism, type InferenceProvider, type InferenceRequest, type InferenceResult } from '@aigg/npc-agent';
import { SharedWorld, type TrajectoryEntry } from '../shared-world';

interface Call { path: string; body: Record<string, unknown> }

function startFakeMemoryServer(): Promise<{ port: number; calls: Call[]; close(): void }> {
  const calls: Call[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : {};
        calls.push({ path: req.url ?? '/', body });
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        if (req.url === '/memory/remember') {
          res.end(JSON.stringify({ ok: true, diagnostics: [], data: { ok: true, units: [{ name: String((body.payload as any)?.name ?? '') }] } }));
        } else if (req.url === '/memory/discernment') {
          res.end(JSON.stringify({ ok: true, diagnostics: [], data: { q: 0, faculty: 0, social: 0, confidence: 0 } }));
        } else if (req.url === '/memory/select') {
          res.end(JSON.stringify({ ok: true, diagnostics: [], data: { units: [], bundle: '', total_in_corpus: 0 } }));
        } else if (req.url === '/memory/units') {
          res.end(JSON.stringify({ ok: true, diagnostics: [], data: { corpus: 'memory', units: [], total: 0 } }));
        } else {
          res.end(JSON.stringify({ ok: false, diagnostics: [{ code: '404', message: 'not found' }], data: null }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as { port: number }).port, calls, close: () => server.close() }));
  });
}

class ScriptedProvider implements InferenceProvider {
  readonly id = 'scripted';
  async complete(_req: InferenceRequest): Promise<InferenceResult> {
    return { text: JSON.stringify({ say: '此话当真?', effects: [], emotion: '存疑' }),
      usage: { model: 'scripted', inputTokens: 40, outputTokens: 30, gccCost: 0.0003 } };
  }
}
const metabolism = new Metabolism({
  tiers: [{ id: 'r', minBalanceGcc: 0.0005, model: 'm', label: '充盈' }, { id: 'l', minBalanceGcc: 0.0001, model: 'm', label: '清醒' }],
  starvingBelowGcc: 0.0001, defaultTierId: 'l',
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const safeSeg = (s: string) => s.replace(/[^a-zA-Z0-9_一-鿿-]/g, '_');
const corpusOf = (id: string) => `npcs/${safeSeg(id)}/memory`;
const obs = (t: TrajectoryEntry[], src: string) =>
  t.filter((e): e is Extract<TrajectoryEntry, { kind: 'observation' }> => e.kind === 'observation' && e.src === src);

async function main() {
  const { port, calls, close } = await startFakeMemoryServer();
  try {
    console.log(`fake agentmf serve on :${port}\n`);
    const client = new AiggMemoryClient({ baseUrl: `http://127.0.0.1:${port}` });
    const world = new SharedWorld({ store: new InMemoryStore(), provider: new ScriptedProvider(), metabolism, memory: client });

    const speaker  = await world.createNpc({ name: 'S_郎中', owner: 'user:A', background: '走方郎中', room: '酒馆', startGcc: 0.0009 });
    const listener = await world.createNpc({ name: 'A_阿珠', owner: 'user:A', background: '富家女',   room: '酒馆', startGcc: 0.0009 });
    const starve   = await world.createNpc({ name: 'D_乞儿', owner: 'user:A', background: '乞丐',     room: '酒馆', startGcc: 0.00005 });
    const away     = await world.createNpc({ name: 'X_摊主', owner: 'user:A', background: '摊主',     room: '集市', startGcc: 0.0009 });
    await sleep(80);

    const LINE = '这丹药包治百病,先付银子';   // 玩家说的
    const REPLY = '此话当真?';                 // NPC 说出口的(ScriptedProvider)—— 旁听听见的是这句
    calls.length = 0;
    await world.talk({ npcId: speaker, visitorId: '游侠', text: LINE, outcome: 'loss' });

    // ---- 1 + 7:注入点① 在 talk() 返回时已落定(await,非 fire-and-forget) ----
    const spk0 = await world.trajectory(speaker);
    const talkObs = obs(spk0, 'talk');
    assert.equal(talkObs.length, 1, '被搭话的 NPC 轨迹有且仅有 1 条 talk 观察');
    assert.equal(talkObs[0].text, LINE, 'talk 观察记下对方原话');
    assert.equal(talkObs[0].from, '游侠', 'talk 观察记下说话者');
    assert.equal(talkObs[0].room, '酒馆', 'talk 观察记下房间');
    assert.equal(obs(await world.trajectory(listener), 'overhear').length, 0, '注入点② 尚未到达(fire-and-forget)');
    console.log('  ✓ 注入点①:talk 观察在 talk() 返回时已落进被搭话者的流(text/from/room 正确)');

    await sleep(300); // 等旁听 fire-and-forget 落定

    // ---- 2:注入点② ----
    const lisObs = obs(await world.trajectory(listener), 'overhear');
    assert.equal(lisObs.length, 1, '同房听众轨迹有 1 条 overhear 观察');
    assert.equal(lisObs[0].from, speaker, 'overhear 观察记下说话者');
    // 旁听承载【整段来回】:玩家先说的 + NPC 答的 —— 同房的人两边都听得见(一次 overhear,
    // 不跑两趟:后者会把 remember 与插话的成本上限翻倍)。
    assert.ok(lisObs[0].text.includes(LINE), 'overhear 观察含玩家先说的那句');
    assert.ok(lisObs[0].text.includes(REPLY), 'overhear 观察含 NPC 答的那句');
    assert.ok(lisObs[0].text.includes('S_郎中') && lisObs[0].text.includes('游侠'), 'overhear 观察记下双方');
    console.log('  ✓ 注入点②:旁听观察落进听众自己的流,承载整段来回(玩家的话也被听见)');

    // 对话者(玩家/来访 NPC)进 match:听见某人兜售的说辞 → 能对【那个人】起警惕
    // 只数【旁听】那条(overheard_ 前缀)—— 听众另有一条来自它自己插话对话的 episodic,
    // 那是既有 talk() 行为,与旁听成本无关。
    const lisRemember = calls.filter((c) => c.path === '/memory/remember'
      && c.body.corpus === corpusOf(listener)
      && /^overheard_/.test(String((c.body.payload as any)?.slug)));
    assert.equal(lisRemember.length, 1, '旁听仍只产生 1 条亲历 episodic(承载整段来回,成本上限不变)');
    const m = (lisRemember[0].body.payload as any).match as string[];
    assert.ok(m.includes('游侠'), 'match 含对话者 —— discernment 可凭这段亲历对说话的那个人起警惕');
    assert.ok((lisRemember[0].body.payload as any).description.includes(LINE), 'episodic 描述含玩家原话');
    console.log('  ✓ 对话者进 match + 描述含其原话(听见谁在兜售,就能对谁生疑)');

    // ---- 3:作用域不串味 ----
    // 玩家那句是对【说话者】说的 —— 绝不该出现在听众流里。
    // (听众流里确有 talk 观察,但那是插话机制:speaker 以「〔旁听插话〕…」回头对听众说话,
    //  复用 talk() 走账本 —— 那是真发生在听众身上的事,理应记录。)
    const lisTalk = obs(await world.trajectory(listener), 'talk');
    assert.ok(!lisTalk.some((e) => e.text === LINE), '听众流里没有玩家对说话者说的原话(不串味)');
    assert.ok(!lisTalk.some((e) => e.from === '游侠'), '听众流里没有以玩家为来源的观察');
    assert.ok(lisTalk.every((e) => e.from === speaker && e.text.includes('旁听插话')), '听众流里的 talk 观察只来自插话机制');
    assert.equal(obs(await world.trajectory(speaker), 'overhear').length, 0, '说话者流里没有 overhear 条目(它是说的人)');
    console.log('  ✓ 作用域:玩家那句不串进听众流;听众的 talk 观察只来自插话');

    // ---- 4 ★ 与记忆闸相反:饥饿者仍记录轨迹,但仍无 episodic remember ----
    assert.equal(obs(await world.trajectory(starve), 'overhear').length, 1, 'starving 听众【仍然】记录轨迹观察(纯 store 写,零成本)');
    const starveRemembers = calls.filter((c) => c.path === '/memory/remember' && c.body.corpus === corpusOf(starve));
    assert.equal(starveRemembers.length, 0, 'starving 听众仍【无】episodic remember(既有成本闸行为不变)');
    console.log('  ✓ 饥饿者:轨迹照记(醒来知道错过什么),记忆闸行为不变(仍不 remember)');

    // ---- 5:异房不记录 ----
    assert.equal((await world.trajectory(away)).length, 0, '异房 NPC 轨迹为空');
    console.log('  ✓ 异房不记录');

    // ---- 6:append-only 累积 + limit ----
    await world.talk({ npcId: speaker, visitorId: '游侠', text: '再来一颗?' });
    const spk1 = await world.trajectory(speaker);
    assert.equal(obs(spk1, 'talk').length, 2, 'append-only:第二次对话累积为 2 条');
    assert.ok(spk1.length >= 2 && spk1[spk1.length - 1].ts >= spk1[0].ts, '按时间递增追加');
    const last1 = await world.trajectory(speaker, 1);
    assert.equal(last1.length, 1, 'trajectory(limit) 只取最近 1 条');
    assert.deepEqual(last1[0], spk1[spk1.length - 1], 'limit 取的是【最近】的那条');
    console.log('  ✓ append-only 累积 + trajectory(limit) 取最近 n');

    console.log('\n✅ P1 PASS —— 轨迹落盘 + talk/overhear 双写');
  } finally {
    close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
