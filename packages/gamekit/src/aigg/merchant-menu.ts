/**
 * merchant-menu — 秦薇商人的菜单树。一站完成 ai.gg 平台的四类购买/充值:
 *
 *   [1] 我的账户       查看 USDC / GCC / 订阅状态(实时链上)
 *   [2] 充值 GCC       通过 x402 用 USDC 兑换 GCC
 *   [3] 购买 GCC       直接参加 CCA 拍卖
 *   [4] 充值 USDC      跨链桥到 Base USDC
 *   [5] 购买订阅 NFT   ERC-8257 套餐(入门 / 专业 / 企业)
 *   [0] 告辞
 *
 * 数据源:链上 ERC-20 balanceOf(USDC / GCC),静态 plans(/api/v1/payment/plans
 * 需 auth,demo 模式离线)。第一版**只展示数据 + 引导**,不自动签 tx —
 * facilitator URL、CCA auction address、套餐价格等给出来,用户自己决策。
 */
import type { MenuNode, MenuStepResult } from './menu-npc';
import type { ChainBalanceProvider } from './chain-balances';
import { BASE_USDC, BASE_GCC } from './chain-balances';
import { DEMO_PLANS, ERC8257_TIERS, type DemoPlan } from './static-plans';
import { AiggExecError, type AiggExecClient, type TopupGccResponse, type BuyGccCcaResponse } from './aigg-exec-client';

const LINE = '─'.repeat(40);

export interface MerchantMenuOptions {
  /** Display name shown in menu titles and farewells. */
  name?: string;
  /** Chain balance reader — when present, the [1] account view shows live numbers. */
  balances?: ChainBalanceProvider;
  /** ai.gg facilitator URL — shown in the GCC top-up guide. */
  facilitatorUrl?: string;
  /** GCC CCA auction address (Base mainnet). */
  ccaAuctionAddress?: string;
  /** ERC-8257 ToolRegistry address. */
  toolRegistryAddress?: string;
  /** When given, the menu shows the visitor's own wallet (resolved per session). */
  walletResolver?: () => string | undefined;

  // ── Phase 2a: confirm-flow real-tx pipeline ──────────────────────────────
  /**
   * ai.gg exec-onchain client. When present, the merchant CAN route [2]/[3]
   * through a real-tx flow (amount → preview → confirm → settle). Absent
   * (or when any of the other Phase 2a knobs below is missing), [2]/[3]
   * fall back to the guide-only views — fully backwards compatible.
   */
  execClient?: AiggExecClient;
  /**
   * Resolves the current visitor's ai.gg API key (the SECRET captured in the
   * Phase 1 handshake). The merchant never sees the key directly; it pulls
   * it just-in-time when sending the exec request.
   */
  apiKeyResolver?: () => string | undefined;
  /**
   * Master switch for the real-tx path. Defaults to `false`. Even when
   * execClient + apiKeyResolver are both wired, [2]/[3] stay guide-only
   * unless the host explicitly opts in (e.g. EXECUTE_ONCHAIN=1 env on
   * mud-server). This makes accidental rollouts impossible.
   */
  executeOnchain?: boolean;
}

const DEFAULT_FACILITATOR = 'https://facilitator.ai.gg';
const DEFAULT_CCA = '0x0000ccaDef455A8b0e7C1c8c2A1F7e1A2c3D4Aa1D';
const DEFAULT_TOOL_REGISTRY = '0x265BB2c66aE08a0Ec1f1A2B8c5Bd9D7C5b6c2cf1';

// ── 子菜单:[1] 账户 ────────────────────────────────────────────────────────
async function buildAccountView(opts: MerchantMenuOptions): Promise<string[]> {
  const wallet = opts.walletResolver?.();
  const lines: string[] = [`\x1b[1m我的 ai.gg 账户\x1b[0m`, LINE];
  if (!wallet) {
    lines.push('  (你还没有链上钱包 — 启用 WALLET_URL 后即派生)');
    return lines;
  }
  lines.push(`  钱包: ${wallet}`);
  if (opts.balances) {
    const bals = await opts.balances.balances(wallet);
    if (bals) {
      lines.push(`  USDC 余额: ${bals.usdc?.formatted ?? '— RPC 失败'} USDC`);
      lines.push(`  GCC  余额: ${bals.gcc?.formatted  ?? '— RPC 失败'} GCC`);
    } else {
      lines.push('  (链上余额读取失败 — 稍后再试)');
    }
  } else {
    lines.push('  (链上余额未开启 — 设 RPC_URL 即查)');
  }
  lines.push('  订阅状态: ' + ERC8257_TIERS[0] + '(查询 NFT 需要查 ToolRegistry,后续接入)');
  return lines;
}

// ── 子菜单:[2] 充值 GCC (x402) ─────────────────────────────────────────────
function buildTopUpGccView(opts: MerchantMenuOptions): string[] {
  const wallet = opts.walletResolver?.();
  const facilitator = opts.facilitatorUrl ?? DEFAULT_FACILITATOR;
  return [
    `\x1b[1m充值 GCC — 用 USDC 兑换\x1b[0m`, LINE,
    '协议: x402 + EIP-3009 (单笔授权,无 gas)',
    `Facilitator: ${facilitator}`,
    `资产: USDC (${BASE_USDC.slice(0,10)}…) on Base mainnet`,
    `目标: 你的 ai.gg 账户余额`,
    '',
    '步骤:',
    `  1. 用你的钱包 ${wallet ?? '(尚未派生)'} 签 EIP-3009 transferWithAuthorization`,
    '  2. 通过 x402 header 提交给 facilitator',
    '  3. facilitator settle 上链 → 后台余额到账',
    '',
    `\x1b[33m提示:\x1b[0m 在 ai.gg 网页打开钱包面板 → "Top up" → 输入金额,签名一次即完成。`,
  ];
}

// ── 子菜单:[3] 购买 GCC (CCA 拍卖) ─────────────────────────────────────────
function buildBuyGccView(opts: MerchantMenuOptions): string[] {
  const auction = opts.ccaAuctionAddress ?? DEFAULT_CCA;
  return [
    `\x1b[1m购买 GCC — CCA 连续清算拍卖\x1b[0m`, LINE,
    'CCA = Continuous Clearing Auction',
    'GCC 在拍卖里直接发行,无中间商;价格按 Q96 fixed-point 实时报价',
    '',
    `Auction 合约: ${auction}`,
    `GCC token:    ${BASE_GCC.slice(0,10)}…`,
    `结算资产:     USDC`,
    '',
    '出价参数你需要:',
    '  - currency_amount       — 你愿出的 USDC',
    '  - max_price_usdc_per_gcc — 接受的最高单价(防被夹)',
    '',
    '\x1b[33m提示:\x1b[0m 出价是不可逆链上 tx,请先在 https://ai.gg/cca 看当前价 + 剩余余额。',
  ];
}

// ── 子菜单:[4] 充值 USDC ───────────────────────────────────────────────────
function buildTopUpUsdcView(_opts: MerchantMenuOptions): string[] {
  return [
    `\x1b[1m充值 USDC — 跨链到 Base\x1b[0m`, LINE,
    '需要 Base 主网 USDC 才能用 ai.gg 的所有付费功能',
    '',
    '主流入口:',
    '  · Coinbase                 — Base 原生支持,出金即到',
    '  · Circle (官方)            — 直接 mint Base USDC',
    '  · Across / Squid / Stargate — 任意链桥到 Base',
    '  · Synapse / Allbridge      — 大额 USDC 桥接',
    '',
    `USDC on Base: ${BASE_USDC}`,
    '',
    '\x1b[33m提示:\x1b[0m 桥费通常 < $1;到账后用 [1] 看余额。',
  ];
}

// ── 子菜单:[5] 购买订阅 NFT (ERC-8257) ─────────────────────────────────────
function buildBuySubscriptionView(opts: MerchantMenuOptions, plan: DemoPlan): string[] {
  const registry = opts.toolRegistryAddress ?? DEFAULT_TOOL_REGISTRY;
  return [
    `\x1b[1m购买订阅 — ${plan.name}\x1b[0m`, LINE,
    `描述: ${plan.description}`,
    `价格: $${plan.priceUsd}  ·  有效期: ${plan.validity}`,
    `含 GCC: ${plan.gccIncluded.toLocaleString()} GCC`,
    `等级: ${ERC8257_TIERS[planTierIndex(plan)]}`,
    '',
    `订阅以 ERC-8257 NFT 形式发放(NFT 在钱包,平台扫描判断 entitlement)`,
    `ToolRegistry: ${registry.slice(0,10)}…`,
    '',
    '步骤:',
    `  1. 用 USDC 支付 $${plan.priceUsd}(经 x402 facilitator 或直接 USDC transfer)`,
    `  2. 后端 mint ERC-8257 NFT 到你的钱包`,
    `  3. 之后所有 ai.gg 调用自动按订阅等级计费`,
    '',
    '\x1b[33m提示:\x1b[0m 在 ai.gg 网页订阅页面完成购买;NFT 出现在钱包即生效。',
  ];
}

function buildPlansList(opts: MerchantMenuOptions, parent: () => MenuNode): MenuNode {
  return {
    title: `${opts.name ?? '秦薇'} · 订阅套餐`,
    body: DEMO_PLANS.map(p =>
      `  ${p.name.padEnd(12)} $${String(p.priceUsd).padStart(4)}/${p.validity}  含 ${p.gccIncluded.toLocaleString().padStart(6)} GCC  · ${p.description}`,
    ),
    actions: [
      ...DEMO_PLANS.map((p, i) => ({
        key: String(i + 1),
        label: `查看 ${p.name}`,
        run: async (): Promise<MenuStepResult> => ({ output: buildBuySubscriptionView(opts, p) }),
      })),
      { key: 'back', label: '返回', run: async () => ({ output: [], next: parent() }) },
      { key: '0',    label: '告辞', run: async () => ({ output: [`${opts.name ?? '秦薇'}: 后会有期。`], exit: true }) },
    ],
  };
}

function planTierIndex(p: DemoPlan): number {
  return p.tier === 'starter' ? 1 : p.tier === 'pro' ? 2 : 3;
}

// ── Phase 2a:exec-onchain confirm flows ──────────────────────────────────
// Each action runs as a 3-step state machine routed through MenuStepResult's
// `prompt` + `handler` fields:
//
//   step 1: ask for amount(s)
//   step 2: call exec(dry_run:true) → preview screen → ask y/n
//   step 3: y → call exec(dry_run:false) with same idempotency_key → tx_hash
//           n → cancel
//
// `idempotency_key` is captured from the dry-run response and re-sent on the
// settle call so retries (rare but possible if a Ctrl-C happens between
// preview and confirm) coalesce safely.
//
// Errors are humanised — AiggExecError.message goes straight to the player,
// while NETWORK_ERROR is mapped to "网络故障,请稍后再试" to avoid leaking
// internal hostnames or stack frames.

/** True only when every Phase 2a knob is present AND opt-in flag is on. */
function execReady(opts: MerchantMenuOptions): boolean {
  return !!(opts.executeOnchain && opts.execClient && opts.apiKeyResolver?.());
}

function humaniseExecError(e: unknown): string {
  if (e instanceof AiggExecError) {
    if (e.code === 'NETWORK_ERROR') return '网络故障,请稍后再试';
    return `${e.message}${e.code ? ` (${e.code})` : ''}`;
  }
  return e instanceof Error ? e.message : 'exec failed';
}

/** Parse a positive decimal amount; reject empty / NaN / ≤0 / >1M (sanity cap). */
function parseAmount(input: string): number | null {
  const n = parseFloat(input.trim());
  if (!isFinite(n) || n <= 0 || n > 1_000_000) return null;
  return n;
}

// ── [2] 充值 GCC confirm flow ────────────────────────────────────────────────
function topupGccFlow(opts: MerchantMenuOptions): MenuStepResult {
  return {
    output: [
      '\x1b[1m充值 GCC(USDC → GCC)\x1b[0m', LINE,
      '我会用你的 ai.gg agent EOA 经 x402 facilitator settle 上链。',
      '',
    ],
    prompt: '请输入要充值的 USDC 金额(例: 10):',
    handler: topupGccAmountHandler(opts),
  };
}

function topupGccAmountHandler(opts: MerchantMenuOptions): (input: string) => Promise<MenuStepResult> {
  return async (input) => {
    const amount = parseAmount(input);
    if (amount === null) {
      return {
        output: ['金额格式不对(必须是 0 < n ≤ 1,000,000 的数字)。再试一次:'],
        prompt: '请输入 USDC 金额:',
        handler: topupGccAmountHandler(opts),
      };
    }
    const apiKey = opts.apiKeyResolver?.();
    if (!apiKey) return { output: ['身份缺失 — 请重连时带 SECRET:sk-aigg-...'] };
    try {
      const preview = await opts.execClient!.exec(apiKey,
        { action: 'topup_gcc', params: { usdc_amount: String(amount) } },
        { dryRun: true }) as TopupGccResponse;
      return {
        output: [
          '\x1b[1m准备充值 — 预览\x1b[0m', LINE,
          `  支付:   ${preview.usdc_amount} USDC`,
          `  获得:   ~${preview.estimated_gcc_credit} GCC (估算)`,
          '',
          `  ${preview.human_summary}`,
          '',
          '\x1b[33m[y] 确认上链(扣 USDC,不可逆)  [n] 取消\x1b[0m',
        ],
        prompt: 'y / n:',
        handler: topupGccConfirmHandler(opts, preview.idempotency_key, amount),
      };
    } catch (e) {
      return { output: [`预览失败: ${humaniseExecError(e)}`] };
    }
  };
}

function topupGccConfirmHandler(
  opts: MerchantMenuOptions, idempotencyKey: string, amount: number,
): (input: string) => Promise<MenuStepResult> {
  return async (input) => {
    const v = input.trim().toLowerCase();
    if (v === 'n' || v === 'no' || v === 'cancel' || v === '取消') {
      return { output: ['已取消,未上链。'] };
    }
    if (v !== 'y' && v !== 'yes' && v !== 'confirm' && v !== '确认') {
      return {
        output: ['请输入 y(确认上链)或 n(取消):'],
        prompt: 'y / n:',
        handler: topupGccConfirmHandler(opts, idempotencyKey, amount),
      };
    }
    const apiKey = opts.apiKeyResolver?.();
    if (!apiKey) return { output: ['身份过期,请重连'] };
    try {
      const res = await opts.execClient!.exec(apiKey,
        { action: 'topup_gcc', params: { usdc_amount: String(amount) } },
        { dryRun: false, idempotencyKey }) as TopupGccResponse;
      return {
        output: [
          '\x1b[32m✓ 充值成功\x1b[0m', LINE,
          `  tx:      ${res.settlement_tx_hash ?? '(无)'}`,
          `  到账:    ${res.usdc_amount} USDC → ${res.credited_gcc_balance ?? '?'} GCC`,
          `  ${res.human_summary}`,
        ],
      };
    } catch (e) {
      return { output: [`\x1b[31m✗ 充值失败:\x1b[0m ${humaniseExecError(e)}`] };
    }
  };
}

// ── [3] CCA 出价 confirm flow ────────────────────────────────────────────────
function buyGccCcaFlow(opts: MerchantMenuOptions): MenuStepResult {
  return {
    output: [
      '\x1b[1m购买 GCC — CCA 拍卖出价\x1b[0m', LINE,
      'CCA = Continuous Clearing Auction;你给 USDC 上限 + 单价上限,合约按当前 spot 撮合。',
      '',
    ],
    prompt: '请输入两个数,用空格分:<USDC 金额> <每 GCC 接受最高 USDC>  (例: 5 0.05)',
    handler: buyGccCcaInputHandler(opts),
  };
}

function buyGccCcaInputHandler(opts: MerchantMenuOptions): (input: string) => Promise<MenuStepResult> {
  return async (input) => {
    const parts = input.trim().split(/\s+/);
    const currency = parseAmount(parts[0] ?? '');
    const maxPrice = parseAmount(parts[1] ?? '');
    if (currency === null || maxPrice === null) {
      return {
        output: ['格式: <USDC 金额> <每 GCC 最高 USDC>  例: 5 0.05'],
        prompt: '重输:',
        handler: buyGccCcaInputHandler(opts),
      };
    }
    const apiKey = opts.apiKeyResolver?.();
    if (!apiKey) return { output: ['身份缺失 — 请重连时带 SECRET:sk-aigg-...'] };
    try {
      const preview = await opts.execClient!.exec(apiKey,
        { action: 'buy_gcc_cca', params: { currency_amount: String(currency), max_price_usdc_per_gcc: String(maxPrice) } },
        { dryRun: true }) as BuyGccCcaResponse;
      return {
        output: [
          '\x1b[1m准备出价 — 预览\x1b[0m', LINE,
          `  上限:   ${preview.currency_amount} USDC`,
          `  单价:   ≤ ${preview.max_price_usdc_per_gcc} USDC/GCC`,
          `  最多获得: ~${preview.estimated_gcc_if_filled} GCC`,
          '',
          `  ${preview.human_summary}`,
          '',
          '\x1b[33m[y] 确认上链  [n] 取消\x1b[0m',
        ],
        prompt: 'y / n:',
        handler: buyGccCcaConfirmHandler(opts, preview.idempotency_key, currency, maxPrice),
      };
    } catch (e) {
      return { output: [`预览失败: ${humaniseExecError(e)}`] };
    }
  };
}

function buyGccCcaConfirmHandler(
  opts: MerchantMenuOptions, idempotencyKey: string, currency: number, maxPrice: number,
): (input: string) => Promise<MenuStepResult> {
  return async (input) => {
    const v = input.trim().toLowerCase();
    if (v === 'n' || v === 'no' || v === 'cancel' || v === '取消') {
      return { output: ['已取消,未上链。'] };
    }
    if (v !== 'y' && v !== 'yes' && v !== 'confirm' && v !== '确认') {
      return {
        output: ['请输入 y(确认)或 n(取消):'],
        prompt: 'y / n:',
        handler: buyGccCcaConfirmHandler(opts, idempotencyKey, currency, maxPrice),
      };
    }
    const apiKey = opts.apiKeyResolver?.();
    if (!apiKey) return { output: ['身份过期,请重连'] };
    try {
      const res = await opts.execClient!.exec(apiKey,
        { action: 'buy_gcc_cca', params: { currency_amount: String(currency), max_price_usdc_per_gcc: String(maxPrice) } },
        { dryRun: false, idempotencyKey }) as BuyGccCcaResponse;
      return {
        output: [
          '\x1b[32m✓ 出价已上链\x1b[0m', LINE,
          `  bid_id:  ${res.bid_id ?? '?'}`,
          `  tx:      ${res.tx_hash ?? '(无)'}`,
          `  ${res.human_summary}`,
        ],
      };
    } catch (e) {
      return { output: [`\x1b[31m✗ 出价失败:\x1b[0m ${humaniseExecError(e)}`] };
    }
  };
}

// ── 主菜单 ──────────────────────────────────────────────────────────────────
export function buildMerchantMenu(opts: MerchantMenuOptions = {}): MenuNode {
  const name = opts.name ?? '秦薇';
  let main: MenuNode;

  const actions = [
    {
      key: '1', label: '我的账户(钱包 / 余额 / 订阅)',
      run: async (): Promise<MenuStepResult> => ({ output: await buildAccountView(opts) }),
    },
    {
      key: '2',
      // Label switches to a real-tx hint when the exec pipeline is fully wired,
      // so the player knows they're about to send a real on-chain action.
      label: execReady(opts) ? '充值 GCC(真上链,USDC → GCC)' : '充值 GCC(USDC → GCC,x402)',
      run: async (): Promise<MenuStepResult> =>
        execReady(opts) ? topupGccFlow(opts) : ({ output: buildTopUpGccView(opts) }),
    },
    {
      key: '3',
      label: execReady(opts) ? '购买 GCC(真出价,CCA 拍卖)' : '购买 GCC(CCA 拍卖)',
      run: async (): Promise<MenuStepResult> =>
        execReady(opts) ? buyGccCcaFlow(opts) : ({ output: buildBuyGccView(opts) }),
    },
    {
      key: '4', label: '充值 USDC(桥到 Base)',
      run: async (): Promise<MenuStepResult> => ({ output: buildTopUpUsdcView(opts) }),
    },
    {
      key: '5', label: '购买订阅 NFT(ERC-8257)',
      run: async (): Promise<MenuStepResult> => ({ output: [], next: buildPlansList(opts, () => main) }),
    },
    { key: '0', label: '告辞', run: async () => ({ output: [`${name}: 后会有期。`], exit: true }) },
  ];

  main = { title: `${name} · 商人`, actions };
  return main;
}
