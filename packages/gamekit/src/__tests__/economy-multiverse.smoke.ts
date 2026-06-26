/**
 * economy-multiverse smoke (spec docs/specs/economy-multiverse.md M1) — ②层 store
 * key 全部 world-scope(`w:<worldId>:…`),offline(no server/LLM,pure store):
 *
 *   1. 共储隔离铁律:**一个** InMemoryStore,两个 SharedWorld(worldId 'pal' / 'cragheart'):
 *      各自 initRiceMarket 不同储备 → riceMarket() 读回自己的(无 last-write-wins);
 *      同 npcId 在两世界 silver/needs/exchange日额度/registry 互不可见、互不撞库;
 *      同 npcId+playerId 的**关系对**(npc-player scope,经 RelationshipMemory 内容 key
 *      前缀隔离 —— pal 裸 / 其余 w:<id>:)两世界亲密度亦不撞库(§2 ②层关系隔离覆盖)。
 *   2. 谓词层:CountingArchive + TieredStore(crossServerStable)证 `w:pal:npc:x:rice`
 *      **不进** archive(②层退出共享层)、`w:pal:npcs` **进** archive(registry 镜像保住)。
 *   3. 惰性迁移(仅 'pal'):裸 `npc:x:silver` 旧值 → pal 世界读出并搬运,二读走 scoped;
 *      非 'pal' 世界对同裸 key 不迁(读 0)。
 *
 * Run: npx tsx src/__tests__/economy-multiverse.smoke.ts
 */
import assert from 'node:assert/strict';
import { SharedWorld } from '../shared-world';
import {
  InMemoryStore, TieredStore, crossServerStable, Metabolism, RelationshipMemory,
  type Store, type Scope, type WriteOptions, type InferenceProvider, type InferenceResult, type NeedsConfig
} from '@aigg/npc-agent';

const W: Scope = { type: 'world' };
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

class Scripted implements InferenceProvider {
  readonly id = 'scripted';
  async complete(): Promise<InferenceResult> {
    return { text: '好。', usage: { model: 's', inputTokens: 1, outputTokens: 1, gccCost: 0 } };
  }
}

/** archive that counts every write it receives — the "shared tier" (on-chain head). */
class CountingArchive implements Store {
  readonly writes: string[] = [];
  private readonly inner = new InMemoryStore();
  async get<T>(s: Scope, k: string) { return this.inner.get<T>(s, k); }
  async set<T>(s: Scope, k: string, v: T, o?: WriteOptions) { this.writes.push(`${s.type}|${k}`); return this.inner.set(s, k, v, o); }
  async delete(s: Scope, k: string) { return this.inner.delete(s, k); }
}

async function main() {
  const rich = new Metabolism({ tiers: [{ id: 'r', minBalanceGcc: 0, model: 'm', label: '充盈' }], starvingBelowGcc: -1, defaultTierId: 'r' });
  const needs: NeedsConfig = { axes: { 食: { decayPerTick: 5, threshold: 30 } }, satisfy: { 集市: { 食: 20 } } };
  const exchange = { enabled: true, rate: 100, dailyCapSilver: 50 };

  // ── 1. 共储隔离铁律:同一只 InMemoryStore,两个世界 ───────────────────────────
  const store = new InMemoryStore();
  const pal = new SharedWorld({ store, provider: new Scripted(), metabolism: rich, needs, exchange, worldId: 'pal', rooms: ['集市'] });
  const crag = new SharedWorld({ store, provider: new Scripted(), metabolism: rich, needs, exchange, worldId: 'cragheart', rooms: ['集市'] });

  // a. 市场:不同储备,各读各的(无 last-write-wins)
  await pal.initRiceMarket({ rice: 1000, silver: 500 });
  await crag.initRiceMarket({ rice: 50, silver: 50 });
  const mPal = (await pal.riceMarket())!;
  const mCrag = (await crag.riceMarket())!;
  assert.equal(mPal.riceReserve, 1000, 'pal 米储 1000(不被 crag 覆盖)');
  assert.equal(mPal.silverReserve, 500, 'pal 银储 500');
  assert.equal(mCrag.riceReserve, 50, 'crag 米储 50(独立)');
  assert.equal(mCrag.silverReserve, 50, 'crag 银储 50');
  console.log('  ✓ 共储两世界各自 initRiceMarket → riceMarket() 互不覆盖(无 last-write-wins)');

  // b. silver:两世界同 npcId,grant 互不可见
  const NID = { name: '测试', owner: 'u', background: '镇民', room: '集市', startGcc: 1, startSilver: 0 };
  const palNpc = await pal.createNpc({ ...NID });
  const cragNpc = await crag.createNpc({ ...NID });
  assert.equal(palNpc, cragNpc, '两世界同 npcId(同 name/owner)');
  await pal.grantSilver(palNpc, 100);
  await crag.grantSilver(cragNpc, 7);
  assert.equal(await pal.balanceSilver(palNpc), 100, 'pal silver 100');
  assert.equal(await crag.balanceSilver(cragNpc), 7, 'crag silver 7(同 npcId 互不见)');
  console.log('  ✓ 同 npcId 两世界 silver 互不可见(world-scope 隔离)');

  // c. needs:各自独立
  await pal.tickNeeds(palNpc, Date.now(), 1);
  const palNeeds = await pal.needsOf(palNpc);
  const cragNeeds = await crag.needsOf(cragNpc);
  assert.ok(Object.keys(palNeeds).length > 0, 'pal needs 已落');
  assert.deepEqual(cragNeeds, {}, 'crag needs 未被 pal 的 tick 污染(独立)');
  console.log('  ✓ needs 各自独立(pal tick 不写入 crag)');

  // d. exchange 日额度:pal 吃掉自己的 cap,crag 全新
  await pal.grantSilver(palNpc, 0);     // pal silver = 100
  await crag.grantSilver(cragNpc, 50);  // crag silver = 57
  const exPal = await pal.exchangeSilverForGcc({ npcId: palNpc, silver: 50 });
  assert.equal(exPal.ok, true, 'pal 兑换 50(吃满日额度)');
  const exPalOver = await pal.exchangeSilverForGcc({ npcId: palNpc, silver: 1 });
  assert.equal(exPalOver.reason, 'daily_cap', 'pal 再兑超日额度 → 拒');
  // crag 的日额度全新(同 npcId,但 exchange:day key world-scope)
  const exCrag = await crag.exchangeSilverForGcc({ npcId: cragNpc, silver: 50 });
  assert.equal(exCrag.ok, true, 'crag 兑换 50 成功(日额度独立、未被 pal 耗尽)');
  console.log('  ✓ exchange 每日额度 world-scope(pal 耗尽不影响 crag)');

  // e. registry:各自只见自己世界注册的 NPC
  const palU = await pal.createNpc({ name: '甲', owner: 'u', background: '镇民', room: '集市', startGcc: 1 });
  const cragU = await crag.createNpc({ name: '乙', owner: 'u', background: '镇民', room: '集市', startGcc: 1 });
  const palIds = (await pal.listNpcs()).map((n) => n.id).sort();
  const cragIds = (await crag.listNpcs()).map((n) => n.id).sort();
  assert.ok(palIds.includes(palU) && !palIds.includes(cragU), 'pal registry 不含 crag 独有 NPC');
  assert.ok(cragIds.includes(cragU) && !cragIds.includes(palU), 'crag registry 不含 pal 独有 NPC');
  // 同 npcId(palNpc===cragNpc)两条记录互不串:各自都在自己的 registry
  assert.ok(palIds.includes(palNpc) && cragIds.includes(cragNpc), '同 npcId 在两 registry 各一条');
  console.log('  ✓ registry world-scope(各世界 listNpcs 只见自己注册的)');

  // f. 关系对(npc-player scope):同 store 双世界同 npcId+playerId 互不撞库。
  //    关系活在 npc-player Scope(非 world),wkey() 够不着 → 由 RelationshipMemory 的
  //    **内容 key 前缀**(w:<worldId>:relationship)隔离。pal 用裸 key(零迁移继承历史),
  //    cragheart 用 w:cragheart: 前缀 → 两世界 snapshotState() 各读各的亲密度。
  //    这复刻 SharedWorld.relPrefix() 的约定(pal→'' / 其余→'w:<id>:'),走真持久化 seam。
  const RID = 'npc:阿关:u';        // npcId
  const PID = 'player:小李';        // playerId(两世界同一对)
  const palRel = new RelationshipMemory(store, '');                 // pal 用裸(== relPrefix('pal'))
  const cragRel = new RelationshipMemory(store, 'w:cragheart:');    // crag 用前缀(== relPrefix('cragheart'))
  await palRel.applyDelta(RID, PID, 9, ['信任'], 1);
  await cragRel.applyDelta(RID, PID, -4, ['敌意'], 2);
  const palAff = (await palRel.get(RID, PID)).affinity;
  const cragAff = (await cragRel.get(RID, PID)).affinity;
  assert.equal(palAff, 9, 'pal 关系亲密度 9(不被 crag 的写覆盖)');
  assert.equal(cragAff, -4, 'crag 关系亲密度 -4(同 npcId+playerId 互不撞库)');
  assert.notDeepEqual((await palRel.get(RID, PID)).tags, (await cragRel.get(RID, PID)).tags, '标签亦不串(信任 vs 敌意)');
  // 反证:若两世界都退化成裸 key(无前缀),就会 last-write-wins 撞库 —— 前缀正是隔离来源。
  const bareLegacy = new RelationshipMemory(store);                 // 默认前缀 '' → 看到的是 pal 那条
  assert.equal((await bareLegacy.get(RID, PID)).affinity, 9, '裸 RelationshipMemory 只见 pal 那条(crag 的 -4 落在 w:cragheart: 前缀下,不撞)');
  console.log('  ✓ 关系对 world-scope(同 npcId+playerId 两世界亲密度互不撞库 —— 内容 key 前缀隔离)');

  // ── 2. 谓词层:②层 scoped rice 不进 archive;scoped registry 进 archive ───────
  const archive = new CountingArchive();
  const tiered = new TieredStore({ hot: new InMemoryStore(), archive, archived: crossServerStable });
  const wPred = new SharedWorld({ store: tiered, provider: new Scripted(), metabolism: rich, worldId: 'pal', rooms: ['集市'] });
  await wPred.createNpc({ name: '丙', owner: 'u', background: '镇民', room: '集市', startGcc: 1 });
  const afterCreate = archive.writes.slice();
  // registry(w:pal:npcs)应已镜像进 archive
  assert.ok(afterCreate.some((w) => w === 'world|w:pal:npcs'), '★ w:pal:npcs(②层 registry)进 archive(镜像保住)');
  // grantRice → w:pal:npc:丙:rice 写入,但不应进 archive(②层退出共享层)
  const rid = 'npc:丙:u';
  await wPred.grantRice(rid, 5);
  assert.ok(!archive.writes.some((w) => w.includes(':rice')), '★ w:pal:npc:丙:rice(②层货物)不进 archive(退出共享层)');
  console.log('  ✓ 谓词层:scoped registry 镜像保住、scoped rice 退出共享层(防静默漏 + 防全局污染)');

  // ── 3. 惰性迁移(仅 'pal'):裸 npc:x:silver → 读出搬运、二读走 scoped ──────────
  // 裸 silver key = `npc:<npcId>:silver`;npcId 本身含 'npc:' 前缀 → 裸 key 是 `npc:npc:迁:u:silver`。
  const MIG = 'npc:迁:u';
  const bareSilver = `npc:${MIG}:silver`;       // npc:npc:迁:u:silver
  const scopedSilver = `w:pal:${bareSilver}`;   // w:pal:npc:npc:迁:u:silver
  const mig = new InMemoryStore();
  await mig.set(W, bareSilver, 88);             // 裸写旧值(模拟 #117 前/M0 残留)
  const wMig = new SharedWorld({ store: mig, provider: new Scripted(), metabolism: rich, worldId: 'pal', rooms: ['集市'] });
  assert.equal(await wMig.balanceSilver(MIG), 88, 'pal 读裸旧值 → 88(读出并搬运)');
  assert.equal(await mig.get(W, scopedSilver), 88, '已搬运到 scoped key');
  // scoped 命中优先:改 scoped 后(grantSilver),裸 key 仍是旧 88(不回看裸)
  await wMig.grantSilver(MIG, 12);              // scoped → 100
  assert.equal(await wMig.balanceSilver(MIG), 100, 'scoped 命中优先 → 100');
  assert.equal(await mig.get(W, bareSilver), 88, '裸 key 不被改(非破坏性兜底,仍 88)');
  console.log('  ✓ 惰性迁移:裸值搬运一次 + scoped 命中优先(不回看裸)');

  // 非 pal 世界不迁:同裸 key 读 0
  const mig2 = new InMemoryStore();
  await mig2.set(W, bareSilver, 88);
  const wMig2 = new SharedWorld({ store: mig2, provider: new Scripted(), metabolism: rich, worldId: 'cragheart', rooms: ['集市'] });
  assert.equal(await wMig2.balanceSilver(MIG), 0, '非 pal 世界对裸 key 不迁 → 0');
  assert.equal(await mig2.get(W, `w:cragheart:${bareSilver}`), null, '非 pal 不写 scoped(无搬运)');
  console.log('  ✓ 非 pal 世界不触发惰性迁移(无裸历史包袱)');

  console.log('\nECONOMY-MULTIVERSE SMOKE PASSED ✅');
}

main().catch((e) => { console.error('economy-multiverse FAILED ❌', e); process.exit(1); });
