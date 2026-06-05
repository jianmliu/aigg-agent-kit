/**
 * Demo subscription-plan catalog for the merchant NPC.
 *
 * The real ai.gg `/api/v1/payment/plans` endpoint is authenticated; this static
 * snapshot lets the merchant NPC explain "what you can buy" to every visitor
 * without server-side auth. Refreshes only when the real plan structure
 * changes — values are illustrative, the *shape* mirrors the live response.
 */
export interface DemoPlan {
  id: string;
  name: string;
  description: string;
  /** USD price */
  priceUsd: number;
  /** validity period — human-readable */
  validity: string;
  /** GCC included (estimated, at current GCT/USDC) */
  gccIncluded: number;
  /** which model family this tier targets */
  tier: 'starter' | 'pro' | 'enterprise';
}

export const DEMO_PLANS: DemoPlan[] = [
  {
    id: 'plan:starter-7d',
    name: '入门 7 日',
    description: '适合体验:DeepSeek/Gemini Flash 等便宜模型',
    priceUsd: 5,
    validity: '7 天',
    gccIncluded: 500,
    tier: 'starter',
  },
  {
    id: 'plan:pro-30d',
    name: '专业 30 日',
    description: 'Claude Haiku/Sonnet · Gemini Pro',
    priceUsd: 30,
    validity: '30 天',
    gccIncluded: 4500,
    tier: 'pro',
  },
  {
    id: 'plan:enterprise-30d',
    name: '企业 30 日',
    description: 'Claude Opus · GPT-4 · 无限模型',
    priceUsd: 200,
    validity: '30 天',
    gccIncluded: 35000,
    tier: 'enterprise',
  },
];

/** ERC-8257 subscription tier labels (mirrors aigg-src `MinTier` config). */
export const ERC8257_TIERS: Record<number, string> = {
  0: '未订阅',
  1: '入门',
  2: '专业',
  3: '企业',
};
