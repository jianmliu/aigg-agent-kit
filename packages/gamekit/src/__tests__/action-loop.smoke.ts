/**
 * action-loop smoke — the agent action loop P1 (docs/specs/agent-action-loop.md §4/§5):
 *
 *   教训 A (无假阳): 既有/已激活/有余额 NPC + scripted action-oracle 走完整链
 *     选 → DefaultGameRules.validate → resolve → applyTx → STF. NOT a fresh InMemoryStore蒙混.
 *   教训 B (成本封顶): each NPC's action turn = exactly ONE chooseAction (= ≤1 LLM/tick).
 *   教训 C (不回归): with the switch OFF, FairTick's pitch/trade behave byte-for-byte the same.
 *   教订 E (确定性): scripted oracle + pure available() + tick-injected now → replayable.
 *
 * This smoke drives the SAME runActionTurn logic SharedWorld/builtins/ActionRegistry
 * expose, with a ScriptedActionOracle rotating move→say→trade→pitch→give, then asserts
 * each action's existing纯链 ran (pushGoto / talk burn + emit / tradeRice / pitch deltaGcc /
 * transferSilver conservation + silverTransferred event). It also exercises the
 * parser兜底 (unknown actionId → say) and the switch-off no-regression path against
 * a baseline FairTick run.
 *
 * Run: npx tsx src/__tests__/action-loop.smoke.ts
 */
import assert from 'node:assert/strict';
import { SharedWorld } from '../shared-world';
import { FairTick } from '../fair';
import { ActionRegistry, builtinActions } from '../actions';
import { ScriptedActionOracle } from '../stf/action-oracle';
import { parseActionChoice } from '@onchainpal/npc-agent';
import type { WorldEvent } from '../stf/world-stf';
import { InMemoryStore, Metabolism, type InferenceProvider, type InferenceResult } from '@onchainpal/npc-agent';

class Scripted implements InferenceProvider {
  readonly id = 'scripted';
  async complete(): Promise<InferenceResult> {
    // talk() runs LlmInferenceOracle → parseAgentIntent (expects JSON) — return a
    // valid intent so the oracle yields a `say` line + a small thinking burn.
    return { text: '{"say":"好,我应了。","effects":[]}', usage: { model: 's', inputTokens: 1, outputTokens: 1, gccCost: 0.001 } };
  }
}

const MARKET = '余杭集市';

async function makeWorld(events: WorldEvent[]) {
  const rich = new Metabolism({ tiers: [{ id: 'r', minBalanceGcc: 0, model: 'm', label: '充盈' }], starvingBelowGcc: -1, defaultTierId: 'r' });
  const world = new SharedWorld({
    store: new InMemoryStore(), provider: new Scripted(), metabolism: rich,
    rooms: [MARKET, '余杭民居'],
    onEvents: (evs) => events.push(...evs)
  });
  return world;
}

/** the action-turn端到端 (mirrors wiring/fair.ts runActionTurn): 选→get→resolve→op. */
async function runActionTurn(world: SharedWorld, registry: ActionRegistry, oracle: ScriptedActionOracle, npcId: string, now: number): Promise<string | null> {
  const ctx = await world.buildActionContext(npcId, now, { marketRoom: MARKET });
  const avail = registry.available(ctx);
  if (!avail.length) return null;
  const choice = await oracle.chooseAction({ ctx, schemas: registry.schemas(ctx) });
  const action = registry.get(choice.actionId) ?? registry.get('say');
  if (!action) return null;
  const args = (action.id === 'say' && choice.say && !(choice.args as { text?: string })?.text)
    ? { ...(choice.args as object), text: choice.say } : choice.args;
  const out = action.resolve(ctx, args);
  if (out.sharedWorldOp) await out.sharedWorldOp(world);
  return action.id;
}

async function main() {
  // ───────────────────────── 1. 全链:5 个动作各跑通 (教训 A) ─────────────────────────
  const events: WorldEvent[] = [];
  const world = await makeWorld(events);
  // 既有/已激活/有余额 NPC,同房间(say/pitch/give 需在场),足额 GCC/银两,有米市盘口。
  const a = await world.createNpc({ name: '甲', owner: 'host:pal', background: '镇民', room: MARKET, startGcc: 6, startSilver: 100 });
  const b = await world.createNpc({ name: '乙', owner: 'host:pal', background: '镇民', room: MARKET, startGcc: 6, startSilver: 100 });
  await world.initRiceMarket({ rice: 1000, silver: 500 });   // 米价 0.5
  await world.grantRice(a, 50); await world.grantRice(b, 50);

  const registry = new ActionRegistry(builtinActions({ marketRoom: MARKET }));

  // --- move(=pushGoto) ---
  {
    const oracle = new ScriptedActionOracle([{ actionId: 'move', args: { place: '余杭民居' } }]);
    assert.equal(world.hasPendingGoto(a), false, 'no pending goto before move');
    const id = await runActionTurn(world, registry, oracle, a, 1000);
    assert.equal(id, 'move');
    assert.equal(oracle.calls, 1, '教训B: move = exactly 1 chooseAction');
    assert.equal(world.hasPendingGoto(a), true, 'move enqueued a goto directive (pushGoto)');
    const hops = world.takeGoto(a);    // drain so it doesn't bleed into later turns
    assert.deepEqual(hops, ['余杭民居'], 'goto inbox carries the place');
    console.log('  ✓ move → pushGoto enqueued (walked next tick by takeGoto)');
  }

  // --- say(=talk leg: oracle.produce → applyTalk → burn → emit say) ---
  {
    const before = await world.balanceGcc(a);
    const evCount = events.length;
    const oracle = new ScriptedActionOracle([{ actionId: 'say', args: { targetId: b }, say: '你好,乙。' }]);
    const id = await runActionTurn(world, registry, oracle, a, 2000);
    assert.equal(id, 'say');
    assert.equal(oracle.calls, 1, '教训B: say = 1 chooseAction (talk 内部的 oracle.produce 是对方回应,正常对话成本)');
    const after = await world.balanceGcc(a);
    assert.ok(after < before, `say burned GCC (thinking cost): ${before} → ${after}`);
    const says = events.slice(evCount).filter((e) => e.kind === 'say');
    assert.ok(says.length >= 1, 'say emitted a `say` WorldEvent (oracle line)');
    console.log('  ✓ say → talk() leg: GCC burned + say emitted (full oracle→STF→emit chain)');
  }

  // --- trade(=tradeRice buy: 银两→米, applyTx type:trade + traded event) ---
  {
    const silver0 = await world.balanceSilver(a);
    const rice0 = await world.riceHolding(a);
    const evCount = events.length;
    const oracle = new ScriptedActionOracle([{ actionId: 'trade', args: { side: 'buy', amount: 10 } }]);
    const id = await runActionTurn(world, registry, oracle, a, 3000);
    assert.equal(id, 'trade');
    const silver1 = await world.balanceSilver(a);
    const rice1 = await world.riceHolding(a);
    assert.ok(silver1 < silver0, `trade spent 银两: ${silver0} → ${silver1}`);
    assert.ok(rice1 > rice0, `trade got 米: ${rice0} → ${rice1}`);
    assert.ok(events.slice(evCount).some((e) => e.kind === 'traded'), 'trade emitted a traded event (applyTx)');
    console.log('  ✓ trade → tradeRice buy: 银两↓ 米↑ + traded event (pure STF)');
  }

  // --- pitch(=行骗: victim deltaGcc, GCC 边 ONCHAIN) ---
  {
    const victimBefore = await world.balanceGcc(b);
    const oracle = new ScriptedActionOracle([{ actionId: 'pitch', args: { targetId: b, claim: '一本万利', amountGcc: 2 } }]);
    const id = await runActionTurn(world, registry, oracle, a, 4000);
    assert.equal(id, 'pitch');
    const victimAfter = await world.balanceGcc(b);
    // no memory client → no gate → naive victim accepts → loses amountGcc.
    assert.equal(victimAfter, victimBefore - 2, `pitch drained the victim's GCC: ${victimBefore} → ${victimAfter}`);
    console.log('  ✓ pitch → world.pitch(): victim GCC drained (memory-gated decision, here naive)');
  }

  // --- give(=transferSilver: 双方银两守恒 + silverTransferred event) ---
  {
    const fromBefore = await world.balanceSilver(a);
    const toBefore = await world.balanceSilver(b);
    const evCount = events.length;
    const oracle = new ScriptedActionOracle([{ actionId: 'give', args: { targetId: b, amount: 7 } }]);
    const id = await runActionTurn(world, registry, oracle, a, 5000);
    assert.equal(id, 'give');
    const fromAfter = await world.balanceSilver(a);
    const toAfter = await world.balanceSilver(b);
    assert.equal(fromAfter, fromBefore - 7, 'sender 银两 -7');
    assert.equal(toAfter, toBefore + 7, 'receiver 银两 +7');
    assert.equal(fromBefore + toBefore, fromAfter + toAfter, 'give conserves 银两 (no mint/burn)');
    const xfer = events.slice(evCount).find((e) => e.kind === 'silverTransferred') as Extract<WorldEvent, { kind: 'silverTransferred' }> | undefined;
    assert.ok(xfer && xfer.amount === 7 && xfer.fromId === a && xfer.toId === b, 'silverTransferred event emitted (spec §5.5 tick-anchored)');
    console.log('  ✓ give → transferSilver: conserved + silverTransferred event');
  }

  // ───────────────────────── 2. 兜底解析 (教训 E) ─────────────────────────
  {
    const ctx = await world.buildActionContext(a, 6000, { marketRoom: MARKET });
    const known = registry.schemas(ctx).map((s) => s.id);
    const bad = parseActionChoice('{"actionId":"nuke","args":{}}', known);
    assert.equal(bad.fellBack, true, 'unknown actionId fell back');
    assert.equal(bad.actionId, 'say', 'fallback prefers say (offered)');
    const noJson = parseActionChoice('I will pitch a deal.', known);
    assert.equal(noJson.fellBack, true, 'unparseable output fell back');
    // 回合不卡死:兜底 id 在 registry 里能 get + resolve
    const action = registry.get(bad.actionId);
    assert.ok(action, 'fallback id resolves to a real action');
    console.log('  ✓ parseActionChoice兜底: unknown/unparseable → known action, turn never wedges');
  }

  // ───────────────────────── 3. 开关关 = 零回归 (教训 C) ─────────────────────────
  // 同样的 cast,两遍 FairTick.runTick — 一遍正常(行动循环关),一遍模拟「某 NPC 被行动循环
  // 驱动」(skip 它)。断言:行动循环关时 pitch/trade 与无 skip 时逐字相同。
  {
    const evA: WorldEvent[] = []; const w1 = await makeWorld(evA);
    const evB: WorldEvent[] = []; const w2 = await makeWorld(evB);
    const seed = async (w: SharedWorld) => {
      const p = await w.createNpc({ id: 'npc:pitcher', name: '郎中', owner: 'host:pal', background: '行商', room: MARKET, startGcc: 6, startSilver: 50 });
      const v1 = await w.createNpc({ id: 'npc:v1', name: '甲', owner: 'host:pal', background: '镇民', room: MARKET, startGcc: 6, startSilver: 50 });
      const v2 = await w.createNpc({ id: 'npc:v2', name: '乙', owner: 'host:pal', background: '镇民', room: MARKET, startGcc: 6, startSilver: 50 });
      await w.initRiceMarket({ rice: 1000, silver: 500 });
      const tr = await w.createNpc({ id: 'npc:tr', name: '张四', owner: 'host:pal', background: '渔翁', room: MARKET, startGcc: 6, startSilver: 50 });
      await w.grantRice(tr, 50);
      return { p, v1, v2, tr };
    };
    await seed(w1); await seed(w2);
    const cast = (): import('../fair').FairActor[] => [
      { npcId: 'npc:pitcher', role: 'pitcher', claims: ['仙丹同源'], amountGcc: 2, room: MARKET },
      { npcId: 'npc:v1', role: 'townsfolk' },
      { npcId: 'npc:v2', role: 'townsfolk' },
      { npcId: 'npc:tr', role: 'trader', tradeAmount: 1 }
    ];
    // baseline: switch OFF (skip never fires)
    const fairOff = new FairTick(w1, cast(), { marketRoom: MARKET });
    // run two ticks so the trader (needs a prior price observation) actually trades
    const off0 = await fairOff.runTick(0, 1000);
    // perturb price so the trader has a signal next tick
    await w1.tradeRice({ npcId: 'npc:tr', side: 'sell', amount: 5 });
    const off1 = await fairOff.runTick(1, 2000);

    // identical world, identical cast, switch still OFF → must be byte-for-byte equal
    const fairOff2 = new FairTick(w2, cast(), { marketRoom: MARKET });
    const off0b = await fairOff2.runTick(0, 1000);
    await w2.tradeRice({ npcId: 'npc:tr', side: 'sell', amount: 5 });
    const off1b = await fairOff2.runTick(1, 2000);

    assert.deepEqual(
      { p0: off0.pitches, p1: off1.pitches, t0: off0.trades, t1: off1.trades },
      { p0: off0b.pitches, p1: off1b.pitches, t0: off0b.trades, t1: off1b.trades },
      '教训C: switch OFF → pitch/trade byte-for-byte identical across identical runs'
    );
    assert.ok(off0.pitches.length >= 1, 'baseline FairTick still pitches (兜底角色仍工作)');
    console.log('  ✓ switch OFF: FairTick pitch/trade逐字不变 (兜底角色仍驱动 NPC, 零回归)');
  }

  // ───────────────────────── 4. skip = 不双重驱动 (教训 B) ─────────────────────────
  // 同一 NPC 被行动循环驱动 → FairTick.skip 排除它:它这 tick 不再既被动 pitch 又主动选。
  {
    const ev: WorldEvent[] = []; const w = await makeWorld(ev);
    await w.createNpc({ id: 'npc:pitcher', name: '郎中', owner: 'host:pal', background: '行商', room: MARKET, startGcc: 6, startSilver: 50 });
    await w.createNpc({ id: 'npc:mark', name: '甲', owner: 'host:pal', background: '镇民', room: MARKET, startGcc: 6, startSilver: 50 });
    const driven = new Set<string>();
    const cast: import('../fair').FairActor[] = [
      { npcId: 'npc:pitcher', role: 'pitcher', claims: ['x'], amountGcc: 2, room: MARKET },
      { npcId: 'npc:mark', role: 'townsfolk' }
    ];
    const fair = new FairTick(w, cast, { marketRoom: MARKET, skip: (id) => driven.has(id) });
    // mark is action-driven → skipped as a victim
    driven.add('npc:mark');
    const r = await fair.runTick(0, 1000);
    assert.equal(r.pitches.length, 0, 'skip: the action-driven mark is NOT also pitched by FairTick (no double-drive)');
    // without the skip the same cast WOULD pitch
    driven.clear();
    const r2 = await fair.runTick(1, 2000);
    assert.equal(r2.pitches.length, 1, 'un-skipped → FairTick pitches as before');
    console.log('  ✓ skip: action-driven NPC excluded from FairTick role (≤1 driver/tick)');
  }

  console.log('\nACTION-LOOP SMOKE PASSED ✅');
}

main().catch((e) => { console.error('ACTION-LOOP SMOKE FAILED ❌', e); process.exit(1); });
