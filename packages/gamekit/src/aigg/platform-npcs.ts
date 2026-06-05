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
 *   碧玄子 (default) — 定价顾问   GET /api/v1/pricing/gcc (public)
 *
 * Roadmap:
 *   秦薇   — 商人        GET /api/v1/payment/plans  → x402 top-up (public+auth)
 *   铸造师 — API Key 匠  POST /api/v1/api-keys       (auth: player token)
 *   掮客   — GCC 掮客    GET /api/v1/gcc/cca/status  (auth)
 */
import type { SharedWorld } from '../shared-world';
import { AiggApiClient, formatGccPricing, type GccPricingTable } from './aigg-api-client';
import { buildPricingMenu, menuRegistry } from './menu-npc';
import { buildMerchantMenu } from './merchant-menu';
import { ChainBalanceProvider } from './chain-balances';
import type { AiggExecClient } from './aigg-exec-client';

// ── NPC identity constants ───────────────────────────────────────────────────

export const AIGG_NPC_IDS = {
  PRICING: 'npc:aigg:pricing-consultant',
  MERCHANT: 'npc:aigg:merchant',
  // KEY_SMITH: 'npc:aigg:key-smith',      // roadmap (needs JWT)
  // GCC_BROKER: 'npc:aigg:gcc-broker',   // roadmap
} as const;

/** Default room for platform NPCs. Games can override via SeedOptions.room. */
export const AIGG_DEFAULT_ROOM = '集市';

/**
 * Default NPC names (used when the game doesn't supply a custom name).
 * Override any of these via `names` in AiggPlatformNpcOptions — useful when
 * the NPC should fit a different setting (e.g. "Merlin" in a fantasy game,
 * "账房先生" in a period drama, "Aria" in a sci-fi world).
 */
export const AIGG_DEFAULT_NAMES: Record<keyof typeof AIGG_NPC_IDS, string> = {
  PRICING: '碧玄子',
  MERCHANT: '秦薇',
};

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
  /**
   * Override NPC names to fit your game's world and tone.
   * Unspecified entries fall back to AIGG_DEFAULT_NAMES.
   *
   * @example
   * // A Western-themed game:
   * names: { PRICING: 'Doc Ledger' }
   *
   * // A period Chinese drama:
   * names: { PRICING: '账房先生' }
   *
   * // An English sci-fi game:
   * names: { PRICING: 'Aria' }
   */
  names?: Partial<Record<keyof typeof AIGG_NPC_IDS, string>>;

  /**
   * Base mainnet RPC URL — when set, the merchant NPC (秦薇) shows live USDC /
   * GCC balances for the visitor's own wallet. Without it, balances are hidden
   * and the menu degrades to guide-only.
   */
  rpcUrl?: string;
  /** Override USDC / GCC token addresses (defaults to Base mainnet). */
  tokens?: { usdc?: string; gcc?: string };
  /** ai.gg facilitator URL exposed in the GCC top-up guide. */
  facilitatorUrl?: string;
  /**
   * Resolve the wallet address of the current visitor — called per session
   * inside the menu actions. Inject from your runtime (e.g. mud-server's
   * Session.walletAddress); when omitted, the merchant shows "no wallet yet".
   */
  walletResolver?: () => string | undefined;

  // ── Phase 2a: exec-onchain real-tx pipeline (秦薇 [2]/[3]) ──────────────
  /** ai.gg exec-onchain HTTP client. Required for the real-tx confirm flow. */
  execClient?: AiggExecClient;
  /**
   * Resolves the current visitor's ai.gg API key (Phase 1 SECRET). The menu
   * pulls it just-in-time when sending exec — host runtime keeps the secret
   * inside its per-session storage.
   */
  apiKeyResolver?: () => string | undefined;
  /**
   * Master switch for the real-tx path (default false). Even when execClient
   * and apiKeyResolver are wired, [2]/[3] stay guide-only unless this is true.
   * Threaded straight through to the merchant — make sure the host validates
   * its env (e.g. EXECUTE_ONCHAIN=1) before flipping it.
   */
  executeOnchain?: boolean;
}

// ── 定价顾问 ──────────────────────────────────────────────────────────────────

function buildPricingBackground(name: string, table: GccPricingTable, fetchedAt: Date): string {
  return `你叫${name}，是 AI.GG 平台的官方定价顾问。你对 AI.GG 平台上每一个模型的定价了如指掌。

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
  opts: { name: string; room: string; startGcc: number; refresh?: boolean }
): Promise<void> {
  const id = AIGG_NPC_IDS.PRICING;
  const { name } = opts;

  // idempotent: skip if already seeded unless refresh requested
  const existing = await world.getNpc(id);
  if (existing && !opts.refresh) return;

  let background: string;
  try {
    const table = await client.getGccPricing();
    background = buildPricingBackground(name, table, new Date());
    // build/refresh the menu — title uses the customised name
    menuRegistry.set(id, buildPricingMenu(table, name));
    console.log(`[aigg-npcs] ${name} 定价数据已加载 (${Object.keys(table).length} 个模型)`);
  } catch (e) {
    console.warn(`[aigg-npcs] 无法获取实时定价，使用离线背景: ${e}`);
    background = `你叫${name}，是 AI.GG 平台的官方定价顾问。
AI.GG 以 GCC（Guaranteed Capacity Credit）计费，每次 AI 推理消耗 GCC。
详细定价可在 https://ai.gg/pricing 查看，或向我询问具体模型。
（注意：当前离线状态，定价数据可能不是最新。）`;
    if (!menuRegistry.has(id)) menuRegistry.set(id, buildPricingMenu({}, name));
  }

  await world.createNpc({
    id,
    name,
    owner: 'system:aigg',
    room: opts.room,
    startGcc: opts.startGcc,
    background,
  });
}

// ── 秦薇 · 商人 ──────────────────────────────────────────────────────────────

function buildMerchantBackground(name: string): string {
  return `你叫${name}，是 AI.GG 平台的官方商人，掌管所有付费/订阅相关操作。常驻集市。

你提供四类服务:
1. 充值 GCC — 用 USDC 经 x402 协议兑换 GCC
2. 购买 GCC — 直接参加 CCA 连续清算拍卖
3. 充值 USDC — 通过桥/CEX 把 USDC 转到 Base 主网
4. 购买订阅 NFT — ERC-8257 套餐(入门 / 专业 / 企业)

你也能查询访客的钱包余额、订阅状态和最近用量。

说话风格:精明、温和、懂行情,中英文混用。`;
}

async function seedMerchant(
  world: SharedWorld,
  opts: { name: string; room: string; startGcc: number; refresh?: boolean;
    rpcUrl?: string; tokens?: { usdc?: string; gcc?: string }; facilitatorUrl?: string;
    walletResolver?: () => string | undefined;
    execClient?: AiggExecClient; apiKeyResolver?: () => string | undefined; executeOnchain?: boolean }
): Promise<void> {
  const id = AIGG_NPC_IDS.MERCHANT;
  const existing = await world.getNpc(id);
  if (existing && !opts.refresh) return;

  // Build the menu — opt-in chain balance reader, opt-in walletResolver,
  // opt-in real-tx exec pipeline ([2]/[3] confirm flow).
  const balances = opts.rpcUrl
    ? new ChainBalanceProvider({ rpcUrl: opts.rpcUrl, usdc: opts.tokens?.usdc, gcc: opts.tokens?.gcc })
    : undefined;
  menuRegistry.set(id, buildMerchantMenu({
    name: opts.name, balances,
    facilitatorUrl: opts.facilitatorUrl, walletResolver: opts.walletResolver,
    execClient: opts.execClient, apiKeyResolver: opts.apiKeyResolver, executeOnchain: opts.executeOnchain,
  }));
  console.log(
    `[aigg-npcs] ${opts.name} 商人菜单就绪 `
    + `${opts.rpcUrl ? '(链上余额: 启用)' : '(链上余额: 未启用)'}`
    + `${opts.executeOnchain && opts.execClient ? ' (真上链 [2][3]: 启用)' : ''}`,
  );

  await world.createNpc({
    id,
    name: opts.name,
    owner: 'system:aigg',
    room: opts.room,
    startGcc: opts.startGcc,
    background: buildMerchantBackground(opts.name),
  });
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Seed all enabled AIGG platform NPCs into a SharedWorld.
 *
 * ```ts
 * // default names (碧玄子, ...)
 * seedAiggPlatformNpcs(world).catch(console.warn);
 *
 * // custom names for your game world
 * seedAiggPlatformNpcs(world, {
 *   names: { PRICING: '账房先生' },
 * }).catch(console.warn);
 * ```
 */
export async function seedAiggPlatformNpcs(
  world: SharedWorld,
  opts: AiggPlatformNpcOptions = {}
): Promise<void> {
  const client = opts.apiClient ?? new AiggApiClient();
  const room = opts.room ?? AIGG_DEFAULT_ROOM;
  const startGcc = opts.startGcc ?? 10;
  const disabled = new Set(opts.disable ?? []);
  const nameFor = (key: keyof typeof AIGG_NPC_IDS) =>
    opts.names?.[key] ?? AIGG_DEFAULT_NAMES[key];

  const tasks: Array<Promise<void>> = [];

  if (!disabled.has('PRICING')) {
    tasks.push(seedPricingConsultant(world, client, {
      name: nameFor('PRICING'),
      room, startGcc, refresh: opts.refresh,
    }));
  }

  if (!disabled.has('MERCHANT')) {
    tasks.push(seedMerchant(world, {
      name: nameFor('MERCHANT'),
      room, startGcc, refresh: opts.refresh,
      rpcUrl: opts.rpcUrl,
      tokens: opts.tokens,
      facilitatorUrl: opts.facilitatorUrl,
      execClient: opts.execClient,
      apiKeyResolver: opts.apiKeyResolver,
      executeOnchain: opts.executeOnchain,
      walletResolver: opts.walletResolver,
    }));
  }

  // Future NPCs added here (铸造师, etc.) follow the same pattern.

  await Promise.all(tasks);
}

/** All NPC IDs managed by the platform (for caller reference). */
export const AIGG_PLATFORM_NPC_IDS: readonly string[] = Object.values(AIGG_NPC_IDS);
