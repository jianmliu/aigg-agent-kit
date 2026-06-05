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
      key: '2', label: '充值 GCC(USDC → GCC,x402)',
      run: async (): Promise<MenuStepResult> => ({ output: buildTopUpGccView(opts) }),
    },
    {
      key: '3', label: '购买 GCC(CCA 拍卖)',
      run: async (): Promise<MenuStepResult> => ({ output: buildBuyGccView(opts) }),
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
