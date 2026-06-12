/**
 * Headless smoke for 需求多轴 (spec 里程碑①A): the pure, engine-neutral needs
 * functions — decay (缺轴补 100 / clamp 0)、urgent 排序、satisfy clamp 100、
 * summarizeNeeds 中文文案、DEFAULT_NEEDS_CONFIG 形。Zero deps, no store, no LLM.
 * Run: pnpm --filter @onchainpal/npc-agent test:needs
 */
import assert from 'node:assert/strict';
import {
  decayNeeds, satisfy, urgent, summarizeNeeds, DEFAULT_NEEDS_CONFIG,
  type NeedsAxis
} from '../index';

async function main() {
  // --- decayNeeds ---
  assert.equal(decayNeeds({ 食: 50 }, { 食: { decayPerTick: 10 } }, 1).食, 40, 'decay 一步');
  assert.equal(decayNeeds({ 食: 50 }, { 食: { decayPerTick: 10 } }, 2).食, 30, 'dt 缩放');
  assert.equal(decayNeeds({}, { 食: { decayPerTick: 2 } }).食, 98, '缺轴以 100 起算再衰');
  assert.equal(decayNeeds({ 食: 5 }, { 食: { decayPerTick: 100 } }).食, 0, 'clamp 0(衰减超额)');
  // 纯:不改入参
  const src = { 食: 50 };
  decayNeeds(src, { 食: { decayPerTick: 10 } });
  assert.equal(src.食, 50, 'decayNeeds 不改入参(返回新对象)');

  // --- urgent 排序 ---
  const axes: Record<string, NeedsAxis> = { 食: { decayPerTick: 1, threshold: 30 }, 群: { decayPerTick: 1, threshold: 30 }, 眠: { decayPerTick: 1, threshold: 30 } };
  assert.deepEqual(urgent({ 食: 10, 群: 25, 眠: 80 }, axes, 30), ['食', '群'], '低于阈值按值升序;满足轴不入');
  assert.deepEqual(urgent({ 食: 90 }, axes, 30), [], '全足 → 空');
  // per-axis threshold 覆盖默认 thr
  assert.deepEqual(urgent({ 敬石神: 27 }, { 敬石神: { decayPerTick: 1, threshold: 25 } }, 30), [], '轴自带 threshold=25 → 27 不算紧迫');

  // --- satisfy clamp 100 ---
  assert.equal(satisfy({ 食: 90 }, '食', 30).食, 100, 'satisfy clamp 100');
  assert.equal(satisfy({}, '食', 5).食, 100, '缺轴以 100 起算 → 满轴');
  assert.equal(satisfy({ 食: 40 }, '食', 20).食, 60, 'satisfy 累加');

  // --- summarizeNeeds 文案 ---
  const line = summarizeNeeds({ 食: 10, 醉: 5 }, axes, 30);
  assert.ok(line.includes('饿'), 'summarize 含「饿」');
  assert.ok(line.includes(','), '多轴用「,」连接');
  assert.equal(summarizeNeeds({ 食: 90 }, axes, 30), '', '全足 → 空串(talk 据此跳过注入)');
  // 程度分档
  assert.ok(summarizeNeeds({ 食: 5 }, axes, 30).startsWith('已经'), '<10 → 「已经」');
  assert.ok(summarizeNeeds({ 食: 15 }, axes, 30).startsWith('很'), '<20 → 「很」');
  assert.ok(summarizeNeeds({ 食: 25 }, axes, 30).startsWith('有些'), 'else → 「有些」');
  // 表外轴回落
  assert.ok(summarizeNeeds({ 怪轴: 5 }, { 怪轴: { decayPerTick: 1, threshold: 30 } }).includes('怪轴有些匮乏'), '表外轴回落「<轴>有些匮乏」');

  // --- DEFAULT_NEEDS_CONFIG 形 ---
  assert.ok(DEFAULT_NEEDS_CONFIG.axes.食 && DEFAULT_NEEDS_CONFIG.axes.眠 && DEFAULT_NEEDS_CONFIG.axes.群, '默认轴 食/眠/群');
  assert.deepEqual(DEFAULT_NEEDS_CONFIG.satisfy, {}, '默认 satisfy 空(无房间满足→纯衰减,行为可控)');

  console.log('✓ decay(缺轴补100/clamp0) + urgent 排序 + satisfy clamp100 + summarize 文案 + 默认形');
  console.log('\nALL NEEDS SMOKE TESTS PASSED ✅');
}

main().catch((err) => { console.error('NEEDS SMOKE TEST FAILED ❌', err); process.exit(1); });
