/**
 * AIGG Platform NPCs — reusable, fixed characters that provide ai.gg platform
 * access inside any MUD game. Every game built on ai.gg can include them with
 * one call; they stay consistent across games.
 *
 * Pattern: menu-based (zero LLM cost, deterministic, no hallucinations).
 * Data is fetched live from the ai.gg public API at startup, injected into
 * the NPC background for any LLM fall-back path, and also registered in
 * menuRegistry for direct menu interaction.
 *
 * Current roster:
 *   碧玄子 — 定价顾问   GET /api/v1/pricing/gcc (public)
 *
 * Roadmap:
 *   秦薇   — 商人        GET /api/v1/payment/plans  → x402 top-up (public+auth)
 *   铸造师 — API Key 匠  POST /api/v1/api-keys       (auth: player token)
 *   掮客   — GCC 掮客    GET /api/v1/gcc/cca/status  (auth)
 */
import type { SharedWorld } from '../shared-world';
import { AiggApiClient, formatGccPricing, type GccPricingTable } from './aigg-api-client';
import { buildPricingMenu, menuRegistry } from './menu-npc';

// ── NPC identity constants ───────────────────────────────────────────────────

export const AIGG_NPC_IDS = {
  PRICING: 'npc:aigg:pricing-consultant',
  // MERCHANT: 'npc:aigg:merchant',        // roadmap
  // KEY_SMITH: 'npc:aigg:key-smith',      // roadmap
  // GCC_BROKER: 'npc:aigg:gcc-broker',   // roadmap
} as const;

/** Default room for platform NPCs. Games can override via SeedOptions.room. */
export const AIGG_DEFAULT_ROOM = '集市';

// ── Seed options ─────────────────────────────────────────────────────────────

export interface AiggPlatformNpcOptions {
  /** ai.gg API client. Default: new AiggApiClient() → https://ai.gg */
  apiClient?: AiggApiClient;
  /**
   * Which room to place the platform NPCs in. Must be one of the world's rooms.
   * Default: '集市'. If the room doesn't exist the NPC falls back to the first room.
   */
  room?: string;
  /** Initial GCC balance for platform NPCs (they never starve mid-session). Default: 10 */
  startGcc?: number;
  /**
   * Force re-seed even if the NPC already exists (e.g. after a pricing update).
   * Default: false (idempotent).
   */
  refresh?: boolean;
  /** Disable individual NPCs. Default: all enabled. */
  disable?: Array<keyof typeof AIGG_NPC_IDS>;
}

// ── 碧玄子 · 定价顾问 ────────────────────────────────────────────────────────

function buildPricingBackground(table: GccPricingTable, fetchedAt: Date): string {
  return `你叫碧玄子，是 AI.GG 平台的官方定价顾问，常驻集市。你对 AI.GG 平台上每一个模型的定价了如指掌。

AI.GG 以 GCC（Guaranteed Capacity Credit，保证算力积分）计费：
- GCC 是链上 ERC-20 代币（Base 主网），代表经过拍卖保证的算力额度
- 每次 AI 推理消耗 GCC，按"每百万 token 消耗量"计算
- 充值 GCC 可通过 x402 协议用 USDC 直接在链上完成

【当前实时定价（更新于 ${fetchedAt.toLocaleString('zh-CN')}）】
${formatGccPricing(table)}

你的能力：
1. 告知任意模型的精确定价（输入/输出分开）
2. 帮玩家估算：给定 token 数 → 消耗多少 GCC
3. 推荐性价比最高的模型
4. 解释 GCC 是什么，如何充值

说话风格：儒雅随和，像账房兼顾问，偶尔用算盘比喻，中英文混用。`;
}

async function seedPricingConsultant(
  world: SharedWorld,
  client: AiggApiClient,
  opts: { room: string; startGcc: number; refresh?: boolean }
): Promise<void> {
  const id = AIGG_NPC_IDS.PRICING;

  // idempotent: skip if already seeded unless refresh requested
  const existing = await world.getNpc(id);
  if (existing && !opts.refresh) return;

  let background: string;
  try {
    const table = await client.getGccPricing();
    background = buildPricingBackground(table, new Date());
    // also build/refresh the menu
    menuRegistry.set(id, buildPricingMenu(table));
    console.log(`[aigg-npcs] 碧玄子 定价数据已加载 (${Object.keys(table).length} 个模型)`);
  } catch (e) {
    console.warn(`[aigg-npcs] 无法获取实时定价，使用离线背景: ${e}`);
    background = `你叫碧玄子，是 AI.GG 平台的官方定价顾问，常驻集市。
AI.GG 以 GCC（Guaranteed Capacity Credit）计费，每次 AI 推理消耗 GCC。
详细定价可在 https://ai.gg/pricing 查看，或向我询问具体模型。
（注意：当前离线状态，定价数据可能不是最新。）`;
    // build fallback menu from empty table (will show empty lists)
    if (!menuRegistry.has(id)) menuRegistry.set(id, buildPricingMenu({}));
  }

  await world.createNpc({
    id,
    name: '碧玄子',
    owner: 'system:aigg',
    room: opts.room,
    startGcc: opts.startGcc,
    background,
  });
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Seed all enabled AIGG platform NPCs into a SharedWorld.
 *
 * Call once at game startup (fire-and-forget safe):
 *
 * ```ts
 * seedAiggPlatformNpcs(world).catch(console.warn);
 * ```
 *
 * Every NPC is idempotent (skips if already present) and degrades gracefully
 * if the ai.gg API is unreachable (fallback background, empty menus).
 */
export async function seedAiggPlatformNpcs(
  world: SharedWorld,
  opts: AiggPlatformNpcOptions = {}
): Promise<void> {
  const client = opts.apiClient ?? new AiggApiClient();
  const room = opts.room ?? AIGG_DEFAULT_ROOM;
  const startGcc = opts.startGcc ?? 10;
  const disabled = new Set(opts.disable ?? []);

  const tasks: Array<Promise<void>> = [];

  if (!disabled.has('PRICING')) {
    tasks.push(seedPricingConsultant(world, client, { room, startGcc, refresh: opts.refresh }));
  }

  // Future NPCs added here (秦薇, 铸造师, etc.) follow the same pattern.

  await Promise.all(tasks);
}

/** All NPC IDs that are managed by the platform (for caller reference). */
export const AIGG_PLATFORM_NPC_IDS: readonly string[] = Object.values(AIGG_NPC_IDS);
