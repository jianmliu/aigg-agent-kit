/**
 * Headless smoke: SharedWorld 旁听(overhearing)against a FAKE agentmf serve.
 * 同房间其他 NPC 听见一段说出口的对话 → 形成 episodic 记忆;rich 听众经 metabolism 门控
 * 可插话(烧 GCC、上账本),穷/饥饿听众只记不说。证明(对照 docs/specs/emergence-world-notes.md §3):
 *   1. 富者插话分叉:rich 听众收到亲历 episodic remember 且【真的插话】(余额被 burn 下降)
 *   2. 穷者只记分叉:lean 听众收到 remember 但【不插话】(余额不变)
 *   3. 饥饿跳过:starving 听众【无】任何 remember、余额不变(即便落在 maxListeners 窗口内)
 *   4. 成本封顶B:>maxListeners 个同房听众 → 经稳定排序 slice(4),窗外听众【无】remember;
 *               插话 ≤ interjectMaxPerTalk(1)
 *   5. 作用域:旁听 remember 写进【听众自己】corpus,不污染说话者 corpus(防裸键/自证泄漏)
 *   6. 异房不旁听:别房间的听众无 remember
 *   7. outcome 透传:speaker outcome:'loss' → 旁听 episode match 含 'trap'(亲历级警惕)
 *   8. 不阻塞(教训C):talk() 立即返回 said;旁听 remember 在 sleep 前还没出现、sleep 后才出现
 *   9. 确定性(教训E):同状态跑两次 → 被记录听众 id 集 + 插话者 id 完全一致
 *  10. 递归不引爆(教训B):插话(_noOverhear)不触发二层旁听 → 总 overheard remember 数 = 首轮窗内非饥饿听众数
 *
 * 破 verified:true 假阳(教训A):【同一个】InMemoryStore + 同一 world,先 createNpc 造好
 * 既有、已激活、有余额、同房间的听众,真正触发 remember 扩散与门控分叉(富者插话 / 穷者只记)。
 *
 * 听众命名刻意用 Latin 前缀(A_/B_/…)把 id 字典序锁死(CJK 码点序不直观),让
 * 「稳定排序后的窗口/首个 rich」可控可断言 —— 排序后窗内 = A_rich,B_lean1,C_lean2,D_starve;
 * 窗外(被 maxListeners=4 截断) = E_lean3,F_lean4。
 *
 * Run: pnpm --filter @onchainpal/gamekit test:overhear
 */
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { AiggMemoryClient } from '@onchainpal/npc-agent';
import { InMemoryStore, Metabolism, type InferenceProvider, type InferenceRequest, type InferenceResult } from '@onchainpal/npc-agent';
import { SharedWorld } from '../shared-world';

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
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, calls, close: () => server.close() });
    });
  });
}

// Scripted oracle: every reply has a non-empty say + a fixed GCC cost (so a 真插话 burns).
class ScriptedProvider implements InferenceProvider {
  readonly id = 'scripted';
  async complete(_req: InferenceRequest): Promise<InferenceResult> {
    return { text: JSON.stringify({ say: '此话当真?', effects: [], emotion: '存疑' }),
      usage: { model: 'scripted', inputTokens: 40, outputTokens: 30, gccCost: 0.0003 } };
  }
}
// rich(id:'r', ≥0.0005, '充盈') / lean(id:'l', ≥0.0001, '清醒');starving < 0.0001
const richMetabolism = new Metabolism({ tiers: [{ id: 'r', minBalanceGcc: 0.0005, model: 'm', label: '充盈' }, { id: 'l', minBalanceGcc: 0.0001, model: 'm', label: '清醒' }], starvingBelowGcc: 0.0001, defaultTierId: 'l' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const safeSeg = (s: string) => s.replace(/[^a-zA-Z0-9_一-鿿-]/g, '_');
const corpusOf = (id: string) => `npcs/${safeSeg(id)}/memory`;

// overheard episodic remember calls landing in a given listener's corpus
function overheardInCorpus(calls: Call[], corpus: string): Call[] {
  return calls.filter((c) => c.path === '/memory/remember'
    && (c.body.payload as any)?.kind === 'episodic'
    && /^overheard_/.test(String((c.body.payload as any)?.slug))
    && c.body.corpus === corpus);
}
// extra say events emitted with a given npc as speaker (插话 → talk(o) emits say with npcId=o)
function saysBy(events: Array<{ kind: string; npcId?: string }>, speakerId: string): number {
  return events.filter((e) => e.kind === 'say' && e.npcId === speakerId).length;
}

// ---------------------------------------------------------------------------
// Build ONE world with EXISTING, activated, funded, same-room listeners (教训A).
// id 字典序(Latin 前缀)锁死:窗内 = A_rich,B_lean1,C_lean2,D_starve;窗外 = E_lean3,F_lean4。
// ---------------------------------------------------------------------------
async function buildWorld(port: number, events: Array<{ kind: string; npcId?: string }>) {
  const client = new AiggMemoryClient({ baseUrl: `http://127.0.0.1:${port}` });
  const store = new InMemoryStore();
  const world = new SharedWorld({
    store, provider: new ScriptedProvider(), metabolism: richMetabolism, memory: client,
    onEvents: (evs) => { for (const e of evs) events.push(e as any); },
  });
  // EXISTING, activated, funded NPCs — created up front, persisted in one store (no fresh store/turn).
  const speaker = await world.createNpc({ name: 'S_郎中',  owner: 'user:A', background: '走方郎中', room: '酒馆', startGcc: 0.0009 });
  const rich    = await world.createNpc({ name: 'A_阿珠',  owner: 'user:A', background: '富家女', room: '酒馆', startGcc: 0.0009 });  // rich → 窗内首位、可插话
  const lean1   = await world.createNpc({ name: 'B_小乙',  owner: 'user:A', background: '帮工',   room: '酒馆', startGcc: 0.0002 });  // lean → 窗内、只记
  const lean2   = await world.createNpc({ name: 'C_阿牛',  owner: 'user:A', background: '挑夫',   room: '酒馆', startGcc: 0.0002 });  // lean → 窗内、只记
  const starve  = await world.createNpc({ name: 'D_乞儿',  owner: 'user:A', background: '乞丐',   room: '酒馆', startGcc: 0.00005 }); // starving → 窗内但整段跳过
  const lean3   = await world.createNpc({ name: 'E_丁三',  owner: 'user:A', background: '货郎',   room: '酒馆', startGcc: 0.0002 });  // 窗外(maxListeners=4 截断)
  const lean4   = await world.createNpc({ name: 'F_王五',  owner: 'user:A', background: '酒保',   room: '酒馆', startGcc: 0.0002 });  // 窗外
  const elsewhere = await world.createNpc({ name: 'X_集市人', owner: 'user:A', background: '摊主', room: '集市', startGcc: 0.0009 }); // 异房 → 不旁听
  await sleep(80); // 让 createNpc 的 goal-seed remember 先落定
  return { client, store, world, ids: { speaker, rich, lean1, lean2, starve, lean3, lean4, elsewhere } };
}

// ---------------------------------------------------------------------------
async function main() {
  const { port, calls, close } = await startFakeMemoryServer();
  try {
    console.log(`fake agentmf serve on :${port}\n`);
    const events: Array<{ kind: string; npcId?: string }> = [];
    const { world, ids } = await buildWorld(port, events);
    const richCorpus = corpusOf(ids.rich);

    // ---- 8. 不阻塞(教训C):remember 在 sleep 前还没扩散 ----
    calls.length = 0; events.length = 0;
    const result = await world.talk({ npcId: ids.speaker, visitorId: '游侠', text: '这丹药包治百病,先付银子', outcome: 'loss' });
    assert.ok(result.said, 'talk() 立即返回非空 said(不被旁听阻塞)');
    assert.equal(overheardInCorpus(calls, richCorpus).length, 0, '教训C:sleep 前旁听 remember 还没出现(fire-and-forget)');
    await sleep(300); // 等旁听 fire-and-forget + 插话 talk 落定
    console.log('  ✓ talk() 立即返回;旁听 remember 在 sleep 前未出现、之后才扩散(不阻塞)');

    // ---- 1. 富者插话分叉:rich 收到亲历 episodic + 真插话(余额下降、emit say) ----
    const richEp = overheardInCorpus(calls, richCorpus);
    assert.equal(richEp.length, 1, 'rich 听众收到 1 条亲历 episodic remember');
    const richBal = await world.balanceGcc(ids.rich);
    assert.ok(richBal < 0.0009, `rich 听众插话烧了 GCC(余额 ${richBal} < 0.0009)`);
    assert.ok(saysBy(events, ids.rich) >= 1, 'rich 听众的插话 emit 了一条以其为 speaker 的 say(上账本、tick 可锚定)');
    console.log('  ✓ 富者分叉:rich 旁听 → 亲历 episodic + 真插话(余额下降、emit say)');

    // ---- 2. 穷者只记分叉:lean 收到 remember 但不插话(余额不变) ----
    for (const leanId of [ids.lean1, ids.lean2]) {
      assert.equal(overheardInCorpus(calls, corpusOf(leanId)).length, 1, `lean 听众 ${leanId} 收到亲历 episodic remember`);
      assert.equal(await world.balanceGcc(leanId), 0.0002, `lean 听众 ${leanId} 余额不变(只记不说)`);
      assert.equal(saysBy(events, leanId), 0, `lean 听众 ${leanId} 无以其为 speaker 的 say(不插话)`);
    }
    console.log('  ✓ 穷者分叉:lean 旁听 → 只 remember、不插话、余额不变');

    // ---- 3. 饥饿跳过(窗内也跳):starve 无 remember、余额不变 ----
    assert.equal(overheardInCorpus(calls, corpusOf(ids.starve)).length, 0, 'starving 听众无任何旁听 episodic remember(整段跳过)');
    assert.equal(await world.balanceGcc(ids.starve), 0.00005, 'starving 听众余额不变');
    console.log('  ✓ 饥饿跳过:starving 听众(即便落在窗口内)无 remember、余额不变');

    // ---- 4. 成本封顶B:窗外听众无 remember;插话 ≤ interjectMaxPerTalk(1) ----
    for (const outId of [ids.lean3, ids.lean4]) {
      assert.equal(overheardInCorpus(calls, corpusOf(outId)).length, 0, `窗外听众 ${outId} 无 remember(maxListeners=4 截断)`);
    }
    const knownIds = new Set(Object.values(ids));
    const totalInterjects = events.filter((e) => e.kind === 'say' && e.npcId !== ids.speaker && knownIds.has(e.npcId as any)).length;
    assert.ok(totalInterjects <= 1, `成本封顶B:本次 talk 插话数 ${totalInterjects} ≤ interjectMaxPerTalk 1`);
    assert.equal(totalInterjects, 1, '恰 1 次插话(窗内仅 1 个 rich,interjectMaxPerTalk=1)');
    console.log(`  ✓ 成本封顶B:窗外 2 听众无 remember(maxListeners=4 截断);插话 ${totalInterjects}≤1`);

    // ---- 5. 作用域:旁听 remember 不污染说话者 corpus,且全是听众自己的 per-NPC 路径 ----
    const allOverheard = calls.filter((c) => c.path === '/memory/remember' && /^overheard_/.test(String((c.body.payload as any)?.slug)));
    assert.ok(!allOverheard.some((c) => c.body.corpus === corpusOf(ids.speaker)), '说话者自己的 corpus 没有旁听内容(防自证泄漏)');
    for (const c of allOverheard) {
      assert.ok(/^npcs\/.+\/memory$/.test(String(c.body.corpus)), `旁听 corpus 是听众自己的 per-NPC 路径(非裸全局键):${c.body.corpus}`);
    }
    console.log('  ✓ 作用域:旁听 remember 写进各听众自己 corpus,不污染说话者,无裸全局键');

    // ---- 6. 异房不旁听 ----
    assert.equal(overheardInCorpus(calls, corpusOf(ids.elsewhere)).length, 0, '集市的听众(异房)无旁听 remember');
    console.log('  ✓ 异房不旁听:集市 NPC 听不见酒馆的对话');

    // ---- 7. outcome 透传:loss → match 含 trap(亲历级警惕) ----
    const richPayload = richEp[0].body.payload as Record<string, unknown>;
    assert.ok(String(richPayload.match).includes('trap'), 'speaker outcome:loss → 旁听 episode match 含 trap(亲历级警惕)');
    assert.equal(richPayload.outcome, 'loss', '旁听 episode 透传 outcome:loss');
    console.log('  ✓ outcome 透传:loss → 旁听 episode match 含 trap、outcome=loss');

    // ---- 10. 递归不引爆(教训B):插话(_noOverhear)不触发二层旁听 ----
    // 总 overheard remember 数 == 首轮窗内非饥饿听众数(A_rich + B_lean1 + C_lean2 = 3,D_starve 跳过)。
    // 若插话引爆二层,rich 的插话(talk(rich, _noOverhear:true))会让其它听众再收一批 overheard → 超出 3。
    assert.equal(allOverheard.length, 3, `递归不引爆:总旁听 remember 数 ${allOverheard.length} == 首轮窗内非饥饿听众数 3(插话 _noOverhear 无二层扩散)`);
    console.log('  ✓ 递归不引爆:插话带 _noOverhear → 无二层旁听,总 overheard remember 数 = 首轮窗内听众数 3');

    // ---- 9. 确定性(教训E):同状态(等价全新 world + 同 startGcc)两次 → 听众集 + 插话者 id 一致 ----
    function digest(cs: Call[], evs: Array<{ kind: string; npcId?: string }>, kn: Set<string>) {
      const heard = [...new Set(cs.filter((c) => c.path === '/memory/remember' && /^overheard_/.test(String((c.body.payload as any)?.slug))).map((c) => String(c.body.corpus)))].sort();
      const interj = [...new Set(evs.filter((e) => e.kind === 'say' && kn.has(e.npcId as any) && !String(e.npcId).includes('S_郎中')).map((e) => e.npcId))].sort();
      return { heard, interj };
    }
    const evB: Array<{ kind: string; npcId?: string }> = [];
    const a = await buildWorld(port, evB);
    calls.length = 0; evB.length = 0;
    await a.world.talk({ npcId: a.ids.speaker, visitorId: '游侠', text: '这丹药包治百病,先付银子', outcome: 'loss' });
    await sleep(300);
    const dA = digest(calls, evB, new Set(Object.values(a.ids)));
    const evC: Array<{ kind: string; npcId?: string }> = [];
    const b = await buildWorld(port, evC);
    calls.length = 0; evC.length = 0;
    await b.world.talk({ npcId: b.ids.speaker, visitorId: '游侠', text: '这丹药包治百病,先付银子', outcome: 'loss' });
    await sleep(300);
    const dB = digest(calls, evC, new Set(Object.values(b.ids)));
    assert.deepEqual(dA.heard, dB.heard, '确定性:两次被记录的听众 corpus 集一致');
    assert.equal(dA.heard.length, 3, '确定性:两次都恰 3 个听众被记录');
    assert.deepEqual(dA.interj, dB.interj, '确定性:两次插话者 id 一致(稳定排序可重放)');
    assert.equal(dA.interj.length, 1, '确定性:恰 1 个插话者(窗内首个 rich + interjectMaxPerTalk=1)');
    console.log('  ✓ 确定性(教训E):同状态两次 → 听众集 + 插话者 id 完全一致、恰 3 听众 1 插话者');

    console.log('\nSHARED-WORLD × OVERHEARING SMOKE PASSED ✅');
  } finally {
    close();
  }
}

main().catch((e) => { console.error('FAILED ❌', e); process.exit(1); });
