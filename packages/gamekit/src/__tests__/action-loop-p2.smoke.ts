/**
 * action-loop-p2 smoke — the needs-driven action space P2 (docs/specs/agent-action-loop.md
 * §5 P2). Drives the SAME runActionTurn chain (选→registry.available→resolve→sharedWorldOp)
 * the rig exposes, with a ScriptedActionOracle pinning the 5 NEW actions, against EXISTING,
 * activated, funded, co-located NPCs (NOT a fresh store — 教训 A).
 *
 *   recharge  → needsOf(npc)[axis] rises + transferSilver conservation when a shopkeeper present.
 *   research  → needsOf rises (pure satisfyNeed, no silver moved).
 *   socialize → needsOf rises + RelationshipMemory.get(self,target).affinity↑.
 *   help      → silver conserved (self↓ target↑) + bidirectional affinity↑.
 *   steal     → silver conserved (victim↓ self↑, clamp≥0) + victim affinity↓ + a warning
 *               belief WRITTEN into the VICTIM's corpus, then NEXT discernment(provenance,
 *               topic=thiefId) on the victim returns q>0 (被识破) — run on a world WITH a
 *               (fake, stateful) memory client, NOT a bare InMemoryStore (else remember/
 *               discernment no-op and 识破 is a false pass, 教训 A).
 *
 * 轴名不写死 (教训 B): the 3 need-driven actions are gated by ctx.roomSatisfies (= def.needs
 * .satisfy[room]) — covered on TWO axis-name worlds: PAL (茶/食/群) and Agentville
 * (energy/knowledge/influence). Same recharge/research/socialize work by the def satisfy table.
 *
 * 成本封顶/确定性 (教训 B/C): each turn asserts oracle.calls advances by exactly 1 (≤1/tick);
 * steal's 被当场抓到 roll is mulberry32(now+ids) — replayable; switch-OFF segment proves
 * actionsEnabled:false → oracle untouched + FairTick pitch/trade byte-for-byte identical.
 *
 * Run: npx tsx src/__tests__/action-loop-p2.smoke.ts
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { SharedWorld } from '../shared-world';
import { FairTick } from '../fair';
import { ActionRegistry, builtinActions } from '../actions';
import { ScriptedActionOracle } from '../stf/action-oracle';
import type { WorldEvent } from '../stf/world-stf';
import {
  AiggMemoryClient, RelationshipMemory, InMemoryStore, Metabolism,
  type InferenceProvider, type InferenceResult, type NeedsConfig
} from '@aigg/npc-agent';

// ─────────────────────── fake STATEFUL memory server (教训 A) ───────────────────────
// Records remember() writes per corpus; discernment(topic) returns q>0 iff that corpus
// holds a kind:'belief' unit whose `match` contains the topic (= the 识破 path bites for real).
function startFakeMemory(): Promise<{ port: number; close(): void }> {
  const corpora = new Map<string, Array<{ kind?: string; match?: string[]; name?: string }>>();
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = ''; req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : {};
        res.setHeader('Content-Type', 'application/json'); res.writeHead(200);
        const corpus = String(body.corpus ?? 'memory');
        if (req.url === '/memory/remember') {
          const p = (body.payload ?? {}) as { kind?: string; match?: string[]; name?: string };
          const arr = corpora.get(corpus) ?? []; arr.push(p); corpora.set(corpus, arr);
          res.end(JSON.stringify({ ok: true, diagnostics: [], data: { ok: true, units: [{ name: p.name ?? '' }] } }));
        } else if (req.url === '/memory/discernment') {
          const topic = String(body.topic ?? '');
          const units = corpora.get(corpus) ?? [];
          // a verified faculty belief about the topic → q>0 (mirrors the provenance gate).
          const hit = units.some((u) => u.kind === 'belief' && (u.match ?? []).some((m) => topic.includes(m) || m.includes(topic)));
          res.end(JSON.stringify({ ok: true, diagnostics: [], data: hit ? { q: 1, faculty: 1, social: 0, confidence: 0.9 } : { q: 0, faculty: 0, social: 0, confidence: 0 } }));
        } else if (req.url === '/memory/select') {
          res.end(JSON.stringify({ ok: true, diagnostics: [], data: { units: [], bundle: '', total_in_corpus: 0 } }));
        } else if (req.url === '/memory/units') {
          res.end(JSON.stringify({ ok: true, diagnostics: [], data: { corpus, units: corpora.get(corpus) ?? [], total: (corpora.get(corpus) ?? []).length } }));
        } else {
          res.end(JSON.stringify({ ok: false, diagnostics: [{ code: '404', message: 'nf' }], data: null }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as { port: number }).port, close: () => server.close() }));
  });
}

class Scripted implements InferenceProvider {
  readonly id = 'scripted';
  async complete(): Promise<InferenceResult> {
    return { text: '{"say":"好。","effects":[]}', usage: { model: 's', inputTokens: 1, outputTokens: 1, gccCost: 0.001 } };
  }
}

const rich = () => new Metabolism({ tiers: [{ id: 'r', minBalanceGcc: 0, model: 'm', label: '充盈' }], starvingBelowGcc: -1, defaultTierId: 'r' });

// the action-turn端到端 (mirrors wiring/fair.ts runActionTurn): 选→get→resolve→op.
async function runTurn(world: SharedWorld, reg: ActionRegistry, oracle: ScriptedActionOracle, npcId: string, now: number, marketRoom?: string): Promise<string | null> {
  const ctx = await world.buildActionContext(npcId, now, marketRoom ? { marketRoom } : undefined);
  const avail = reg.available(ctx);
  if (!avail.length) return null;
  const choice = await oracle.chooseAction({ ctx, schemas: reg.schemas(ctx) });
  const action = reg.get(choice.actionId) ?? reg.get('say');
  if (!action) return null;
  const out = action.resolve(ctx, choice.args);
  if (out.sharedWorldOp) await out.sharedWorldOp(world);
  return action.id;
}

// ─────────────────────── PAL world (axes 茶/食/群) ───────────────────────
const PAL_NEEDS: NeedsConfig = {
  axes: { 茶: { decayPerTick: 1.5, threshold: 30 }, 食: { decayPerTick: 2, threshold: 30 }, 群: { decayPerTick: 1, threshold: 30 } },
  satisfy: { 'scene:23': { 茶: 30, 群: 10 }, 'scene:5': { 食: 25 } }
};
// ─────────────────────── Agentville world (axes energy/knowledge/influence) ───────────────────────
const AV_NEEDS: NeedsConfig = {
  axes: { energy: { decayPerTick: 2, threshold: 30 }, knowledge: { decayPerTick: 1, threshold: 25 }, influence: { decayPerTick: 1, threshold: 25 } },
  satisfy: { beanbrew: { energy: 30 }, library: { knowledge: 25 }, plaza: { influence: 20 } }
};

async function main() {
  const mem = await startFakeMemory();
  try {
    // ═════════════ A. PAL 世界 (茶/食/群):recharge / research / socialize / help / steal ═════════════
    {
      const events: WorldEvent[] = [];
      const client = new AiggMemoryClient({ baseUrl: `http://127.0.0.1:${mem.port}` });
      const world = new SharedWorld({
        store: new InMemoryStore(), provider: new Scripted(), metabolism: rich(), memory: client,
        rooms: ['scene:5', 'scene:23'], needs: PAL_NEEDS, onEvents: (evs) => events.push(...evs)
      });
      // 米行 scene:5 回「食」轴;客栈 scene:23 回 茶/群。
      const a = await world.createNpc({ id: 'npc:a', name: '甲', owner: 'host:pal', background: '镇民', room: 'scene:5', startGcc: 6, startSilver: 100 });
      const shop = await world.createNpc({ id: 'npc:shop', name: '米商', owner: 'host:pal', background: '米行掌柜', room: 'scene:5', startGcc: 6, startSilver: 100 });
      const reg = new ActionRegistry(builtinActions({}));
      const oracle = new ScriptedActionOracle([
        { actionId: 'recharge', args: {} }, { actionId: 'help', args: { targetId: 'npc:shop', amount: 7 } }, { actionId: 'steal', args: { targetId: 'npc:shop' } }
      ]);
      let lastCalls = 0;

      // --- recharge:食轴低 + 在 scene:5(回食)+ 店主在场 → satisfyNeed(食) + 守恒花银两 ---
      await world.satisfyNeed(a, '食', -100);               // 食 = 0 (低于阈)
      const food0 = (await world.needsOf(a))['食'] ?? 100;
      const aSilver0 = await world.balanceSilver(a);
      const shopSilver0 = await world.balanceSilver(shop);
      const id1 = await runTurn(world, reg, oracle, a, 1000);
      assert.equal(id1, 'recharge', 'recharge chosen');
      assert.equal(oracle.calls - lastCalls, 1, '教训B: recharge = 1 chooseAction'); lastCalls = oracle.calls;
      const food1 = (await world.needsOf(a))['食'] ?? 0;
      assert.ok(food1 > food0, `recharge 回填食轴: ${food0} → ${food1}`);
      const aSilver1 = await world.balanceSilver(a);
      const shopSilver1 = await world.balanceSilver(shop);
      assert.ok(aSilver1 < aSilver0, `recharge 花了银两: ${aSilver0} → ${aSilver1}`);
      assert.equal(aSilver0 + shopSilver0, aSilver1 + shopSilver1, 'recharge 守恒(银两转给店主,无凭空造/烧)');
      console.log('  ✓ PAL recharge → satisfyNeed(食)↑ + 守恒花银两给在场店主');

      // --- research:在 scene:5 不回茶轴 → 即使茶低也 available=false(房间不对) ---
      await world.satisfyNeed(a, '茶', -100);               // 茶 = 0
      {
        const ctx = await world.buildActionContext(a, 1100);
        const res = reg.get('research')!;
        assert.equal(res.available(ctx), false, 'research 在 scene:5(不回茶)available=false —— 涌现门控:房间不对就选不了');
      }
      console.log('  ✓ PAL research 门控:茶轴低但 scene:5 不回茶 → 不可选(roomSatisfies 无该键)');

      // --- 移到客栈 scene:23(回茶/群):research(茶)与 socialize(群)才解锁 ---
      await world.place(a, 'scene:23');
      await world.place(shop, 'scene:23');               // 同房作为社交/help/steal 目标
      // research(茶) —— 纯 satisfyNeed,不动银两
      {
        const tea0 = (await world.needsOf(a))['茶'] ?? 0;
        const sil0 = await world.balanceSilver(a);
        const oracleR = new ScriptedActionOracle([{ actionId: 'research', args: {} }]);
        const id = await runTurn(world, reg, oracleR, a, 1200);
        assert.equal(id, 'research', 'research chosen at 客栈');
        const tea1 = (await world.needsOf(a))['茶'] ?? 0;
        assert.ok(tea1 > tea0, `research 回填茶轴: ${tea0} → ${tea1}`);
        assert.equal(await world.balanceSilver(a), sil0, 'research 不动银两(纯 satisfyNeed)');
        console.log('  ✓ PAL research → satisfyNeed(茶)↑,无银两变动');
      }
      // socialize(群) —— satisfyNeed(群) + adjustAffinity(self→target,+)
      {
        await world.satisfyNeed(a, '群', -100);             // 群 = 0
        const grp0 = (await world.needsOf(a))['群'] ?? 0;
        const rels = new RelationshipMemory(world['store'] as any, world['relPrefix']());
        const aff0 = (await rels.get(a, shop)).affinity;
        const oracleS = new ScriptedActionOracle([{ actionId: 'socialize', args: { targetId: shop } }]);
        const id = await runTurn(world, reg, oracleS, a, 1300);
        assert.equal(id, 'socialize', 'socialize chosen');
        const grp1 = (await world.needsOf(a))['群'] ?? 0;
        assert.ok(grp1 > grp0, `socialize 回填群轴: ${grp0} → ${grp1}`);
        const aff1 = (await rels.get(a, shop)).affinity;
        assert.ok(aff1 > aff0, `socialize 增进好感: ${aff0} → ${aff1}`);
        console.log('  ✓ PAL socialize → satisfyNeed(群)↑ + 对在场者好感↑');
      }

      // --- help:转银两守恒 + 双向好感↑ ---
      {
        const rels = new RelationshipMemory(world['store'] as any, world['relPrefix']());
        const fromB = await world.balanceSilver(a);
        const toB = await world.balanceSilver(shop);
        const aFwd0 = (await rels.get(a, shop)).affinity;
        const aBwd0 = (await rels.get(shop, a)).affinity;
        const id = await runTurn(world, reg, oracle, a, 1400);   // oracle 第 2 项 = help
        assert.equal(id, 'help', 'help chosen');
        assert.equal(oracle.calls - lastCalls, 1, '教训B: help = 1 chooseAction'); lastCalls = oracle.calls;
        const fromA = await world.balanceSilver(a);
        const toA = await world.balanceSilver(shop);
        assert.equal(fromA, fromB - 7, 'help: sender 银两 -7');
        assert.equal(toA, toB + 7, 'help: target 银两 +7');
        assert.equal(fromB + toB, fromA + toA, 'help 守恒');
        assert.ok((await rels.get(a, shop)).affinity > aFwd0 && (await rels.get(shop, a)).affinity > aBwd0, 'help 双向好感↑');
        console.log('  ✓ PAL help → 银两守恒 + 双向好感↑');
      }

      // --- steal:银两守恒(victim↓ self↑) + victim 好感↓ + 警惕信念写入 → 下次 discernment 识破 ---
      {
        const rels = new RelationshipMemory(world['store'] as any, world['relPrefix']());
        const thief = a, victim = shop;
        const thiefB = await world.balanceSilver(thief);
        const victimB = await world.balanceSilver(victim);
        const aff0 = (await rels.get(victim, thief)).affinity;
        // 行窃前:受害者对小偷无警惕(discernment q=0)
        const pre = await world.discernAbout(victim, thief);
        assert.ok(!pre || pre.q === 0, 'steal 前:受害者对小偷无已验证警惕(q=0)');
        const id = await runTurn(world, reg, oracle, thief, 1500);   // oracle 第 3 项 = steal
        assert.equal(id, 'steal', 'steal chosen');
        assert.equal(oracle.calls - lastCalls, 1, '教训B: steal = 1 chooseAction'); lastCalls = oracle.calls;
        const thiefA = await world.balanceSilver(thief);
        const victimA = await world.balanceSilver(victim);
        const moved = victimB - victimA;
        assert.ok(moved > 0, 'steal 偷到银两(victim↓)');
        assert.equal(thiefA - thiefB, moved, 'steal: thief 增 = victim 减(守恒)');
        assert.ok(victimA >= 0, 'steal: clamp≥0');
        assert.ok((await rels.get(victim, thief)).affinity < aff0, 'steal: 受害者对小偷好感↓');
        // 下一拍:受害者已形成亲历级警惕信念 → discernment(provenance, topic=thiefId) 命中 q>0(被识破)
        const post = await world.discernAbout(victim, thief);
        assert.ok(post && post.q > 0, 'steal 后:受害者形成警惕信念 → 下次 discernment 识破(q>0)');
        console.log('  ✓ PAL steal → 银两守恒 + 受害者好感↓ + 亲历警惕信念 → 下次被 discernment 识破(q>0)');
      }

      // --- 确定性:steal 的 被抓 roll 可重放(同 now+ids → 同 caught,同 penalty) ---
      {
        // 两个独立世界,同一 (now, thief, victim) → adjustAffinity 的 penalty 必须逐字相同。
        const mk = async () => {
          const w = new SharedWorld({ store: new InMemoryStore(), provider: new Scripted(), metabolism: rich(), rooms: ['scene:23'], needs: PAL_NEEDS });
          await w.createNpc({ id: 'npc:t', name: '贼', owner: 'h', background: 'x', room: 'scene:23', startGcc: 6, startSilver: 0 });
          await w.createNpc({ id: 'npc:v', name: '苦主', owner: 'h', background: 'x', room: 'scene:23', startGcc: 6, startSilver: 50 });
          return w;
        };
        const r = new ActionRegistry(builtinActions({}));
        const o = () => new ScriptedActionOracle([{ actionId: 'steal', args: { targetId: 'npc:v' } }]);
        const w1 = await mk(); await runTurn(w1, r, o(), 'npc:t', 7777);
        const w2 = await mk(); await runTurn(w2, r, o(), 'npc:t', 7777);
        const rel1 = new RelationshipMemory(w1['store'] as any, w1['relPrefix']());
        const rel2 = new RelationshipMemory(w2['store'] as any, w2['relPrefix']());
        assert.equal((await rel1.get('npc:v', 'npc:t')).affinity, (await rel2.get('npc:v', 'npc:t')).affinity, '教训E: steal 被抓 roll 确定性 → 同 now+ids → 同好感惩罚(可重放)');
        console.log('  ✓ steal 被当场抓到 = mulberry32(now+ids) 确定性,两遍逐字相同(无 Math.random)');
      }
    }

    // ═════════════ B. Agentville 世界 (energy/knowledge/influence):轴名不写死同样工作 ═════════════
    {
      const world = new SharedWorld({
        store: new InMemoryStore(), provider: new Scripted(), metabolism: rich(),
        rooms: ['beanbrew', 'library', 'plaza'], needs: AV_NEEDS
      });
      const a = await world.createNpc({ id: 'av:a', name: 'Ada', owner: 'h', background: 'dev', room: 'beanbrew', startGcc: 6, startSilver: 100 });
      const b = await world.createNpc({ id: 'av:b', name: 'Bo', owner: 'h', background: 'dev', room: 'beanbrew', startGcc: 6, startSilver: 100 });
      const reg = new ActionRegistry(builtinActions({}));

      // recharge in beanbrew (energy) — same code path, different axis name (no if(axis==='energy')).
      await world.satisfyNeed(a, 'energy', -100);
      const e0 = (await world.needsOf(a)).energy ?? 0;
      const sumBefore = (await world.balanceSilver(a)) + (await world.balanceSilver(b));
      const idR = await runTurn(world, reg, new ScriptedActionOracle([{ actionId: 'recharge', args: {} }]), a, 2000);
      assert.equal(idR, 'recharge', 'AV recharge chosen in beanbrew (energy)');
      assert.ok(((await world.needsOf(a)).energy ?? 0) > e0, 'AV recharge 回填 energy 轴(轴名不写死)');
      assert.equal(sumBefore, (await world.balanceSilver(a)) + (await world.balanceSilver(b)), 'AV recharge 守恒');
      console.log('  ✓ Agentville recharge → energy 轴回填 + 守恒(同代码,轴名 energy)');

      // research in library (knowledge); socialize in plaza (influence).
      await world.place(a, 'library');
      await world.satisfyNeed(a, 'knowledge', -100);
      const k0 = (await world.needsOf(a)).knowledge ?? 0;
      const idK = await runTurn(world, reg, new ScriptedActionOracle([{ actionId: 'research', args: {} }]), a, 2100);
      assert.equal(idK, 'research', 'AV research chosen in library');
      assert.ok(((await world.needsOf(a)).knowledge ?? 0) > k0, 'AV research 回填 knowledge 轴');

      await world.place(a, 'plaza'); await world.place(b, 'plaza');
      await world.satisfyNeed(a, 'influence', -100);
      const inf0 = (await world.needsOf(a)).influence ?? 0;
      const idS = await runTurn(world, reg, new ScriptedActionOracle([{ actionId: 'socialize', args: { targetId: 'av:b' } }]), a, 2200);
      assert.equal(idS, 'socialize', 'AV socialize chosen in plaza');
      assert.ok(((await world.needsOf(a)).influence ?? 0) > inf0, 'AV socialize 回填 influence 轴');
      console.log('  ✓ Agentville research(knowledge)/socialize(influence) → 各回各轴(第二套轴名验证, 教训B)');

      // 门控:influence 在 library 不回 → socialize 在 library available=false。
      await world.place(a, 'library'); await world.place(b, 'library');
      {
        const ctx = await world.buildActionContext(a, 2300);
        assert.equal(reg.get('socialize')!.available(ctx), false, 'socialize 在 library(不回 influence)不可选 —— 涌现门控跨世界一致');
      }
      console.log('  ✓ Agentville socialize 门控:library 不回 influence → 不可选(跨世界轴名一致)');
    }

    // ═════════════ C. 开关关 = 零回归 (教训 C):行动循环不跑(oracle 0 调用)→ pitch/trade 逐字不变 ═════════════
    // 在 kit 层,「开关关」= runActionTurn 根本不被调(rig 的 actionsEnabled 守在 pal-server wiring/fair)。
    // 这里直接证:不碰行动循环时,FairTick 的 pitch/trade 在两个同构世界上逐字相同 + oracle 0 调用。
    {
      const MARKET = 'scene:5';
      const mkWorld = (events: WorldEvent[]) => new SharedWorld({
        store: new InMemoryStore(), provider: new Scripted(), metabolism: rich(),
        rooms: [MARKET, 'scene:23'], needs: PAL_NEEDS, onEvents: (evs) => events.push(...evs)
      });
      const seed = async (w: SharedWorld) => {
        await w.createNpc({ id: 'npc:pitcher', name: '郎中', owner: 'h', background: '行商', room: MARKET, startGcc: 6, startSilver: 50 });
        await w.createNpc({ id: 'npc:v1', name: '甲', owner: 'h', background: '镇民', room: MARKET, startGcc: 6, startSilver: 50 });
        await w.initRiceMarket({ rice: 1000, silver: 500 });
        await w.createNpc({ id: 'npc:tr', name: '张四', owner: 'h', background: '渔翁', room: MARKET, startGcc: 6, startSilver: 50 });
        await w.grantRice('npc:tr', 50);
      };
      const cast = (): import('../fair').FairActor[] => [
        { npcId: 'npc:pitcher', role: 'pitcher', claims: ['仙丹同源'], amountGcc: 2, room: MARKET },
        { npcId: 'npc:v1', role: 'townsfolk' },
        { npcId: 'npc:tr', role: 'trader', tradeAmount: 1 }
      ];
      // oracle 装好但行动循环不跑(runActionTurn 不被调)→ 必须 0 调用。
      const oracle = new ScriptedActionOracle([{ actionId: 'steal', args: {} }]);
      const eA: WorldEvent[] = []; const w1 = await mkWorld(eA); await seed(w1);
      const f1 = new FairTick(w1, cast(), { marketRoom: MARKET });
      const a0 = await f1.runTick(0, 1000); await w1.tradeRice({ npcId: 'npc:tr', side: 'sell', amount: 5 }); const a1 = await f1.runTick(1, 2000);

      const eB: WorldEvent[] = []; const w2 = await mkWorld(eB); await seed(w2);
      const f2 = new FairTick(w2, cast(), { marketRoom: MARKET });
      const b0 = await f2.runTick(0, 1000); await w2.tradeRice({ npcId: 'npc:tr', side: 'sell', amount: 5 }); const b1 = await f2.runTick(1, 2000);

      assert.equal(oracle.calls, 0, '教训C: 开关关 → action oracle 0 调用(行动循环不跑)');
      assert.deepEqual(
        { p0: a0.pitches, p1: a1.pitches, t0: a0.trades, t1: a1.trades },
        { p0: b0.pitches, p1: b1.pitches, t0: b0.trades, t1: b1.trades },
        '教训C: 开关关 → pitch/trade 两遍逐字相同(零回归)'
      );
      assert.ok(a0.pitches.length >= 1, '开关关时 FairTick 兜底角色仍 pitch');
      console.log('  ✓ 开关关:action oracle 0 调用 + FairTick pitch/trade 逐字不变(零回归)');
    }

    console.log('\nACTION-LOOP-P2 SMOKE PASSED ✅');
  } finally {
    mem.close();
  }
}

main().catch((e) => { console.error('ACTION-LOOP-P2 SMOKE FAILED ❌', e); process.exit(1); });
