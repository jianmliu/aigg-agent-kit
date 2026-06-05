/**
 * menu-npc — deterministic menu-based NPC interaction.
 *
 * Instead of an LLM, menu NPCs present numbered options. The player selects by
 * typing a number; the NPC executes a deterministic action (API lookup, cost
 * calculation, …). No LLM token cost; no hallucinations; works offline.
 *
 * Session state: Session.menu holds the current MenuNode and optional input mode
 * for multi-step flows (e.g. cost estimation awaiting model + token counts).
 */
import { AiggApiClient, type GccPricingTable, formatGccPricing } from './aigg-api-client';

// ── types ──────────────────────────────────────────────────────────────────

export interface MenuAction {
  /** displayed key: "0"–"9" or short keyword */
  key: string;
  label: string;
  run(): Promise<MenuStepResult>;
}

export interface MenuNode {
  title: string;
  /** lines shown above the action list on each render */
  body?: string[];
  actions: MenuAction[];
}

export interface MenuStepResult {
  /** lines to send to the player */
  output: string[];
  /** navigate to a different node (or stay on current if omitted) */
  next?: MenuNode;
  /** close the menu session */
  exit?: boolean;
  /** switch to free-text input mode (e.g. cost calculator) */
  prompt?: string;
  handler?: (input: string) => Promise<MenuStepResult>;
}

export interface MenuState {
  npcId: string;
  npcName: string;
  node: MenuNode;
  /** when set, next bare-text input is passed to this handler instead of menu navigation */
  freeInput?: { prompt: string; handler: (input: string) => Promise<MenuStepResult> };
}

// ── renderer ────────────────────────────────────────────────────────────────

const LINE = '─'.repeat(36);

export function renderMenu(node: MenuNode): string[] {
  const lines: string[] = [`\x1b[1m${node.title}\x1b[0m`, LINE];
  if (node.body?.length) { lines.push(...node.body, ''); }
  for (const a of node.actions) {
    lines.push(`  \x1b[33m[${a.key}]\x1b[0m ${a.label}`);
  }
  lines.push(LINE);
  return lines;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function parseTokens(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/,/g, '');
  const m = s.match(/^([\d.]+)(k|m)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (m[2] === 'k') return Math.round(n * 1_000);
  if (m[2] === 'm') return Math.round(n * 1_000_000);
  return Math.round(n);
}

function fmtN(n: number): string { return n.toLocaleString(); }

// ── 碧玄子 pricing menu ──────────────────────────────────────────────────────

const PROVIDERS: Record<string, string[]> = {
  'Anthropic Claude': ['claude'],
  'Google Gemini':    ['gemini'],
  'OpenAI':           ['gpt', 'o1', 'o3', 'o4'],
  'DeepSeek':         ['deepseek'],
  'Codex':            ['codex'],
};

function providerOf(model: string): string {
  for (const [name, prefixes] of Object.entries(PROVIDERS)) {
    if (prefixes.some(p => model.startsWith(p))) return name;
  }
  return '其他';
}

function formatModelLine(model: string, p: ModelGccPricing): string {
  return `  ${model.padEnd(38)} 输入 ${String(p.gcc_per_million_input).padStart(6)} / 输出 ${String(p.gcc_per_million_output).padStart(6)}  GCC/M`;
}

import type { ModelGccPricing } from './aigg-api-client';

function calcMenu(table: GccPricingTable, parent: () => MenuNode): MenuNode {
  return {
    title: '碧玄子 · 估算费用',
    body: [
      '请直接输入: 模型名 输入token数 输出token数',
      '示例: claude-haiku-4-5 1000000 200000',
      '支持: 1k = 1,000  1m = 1,000,000',
    ],
    actions: [
      { key: 'back', label: '返回', run: async () => ({ output: [], next: parent() }) },
      { key: '0',    label: '告辞', run: async () => ({ output: ['碧玄子: 慢走，有缘再会！'], exit: true }) },
    ],
  };
}

function providerMenu(table: GccPricingTable, providerName: string, parent: () => MenuNode): MenuNode {
  const models = Object.entries(table).filter(([m]) => providerOf(m) === providerName);
  models.sort((a, b) => a[0].localeCompare(b[0]));
  return {
    title: `碧玄子 · ${providerName} 定价`,
    body: models.map(([m, p]) => formatModelLine(m, p)),
    actions: [
      { key: 'back', label: '返回', run: async () => ({ output: [], next: parent() }) },
      { key: '0',    label: '告辞', run: async () => ({ output: ['碧玄子: 慢走，有缘再会！'], exit: true }) },
    ],
  };
}

export function buildPricingMenu(table: GccPricingTable): MenuNode {
  // gather providers that have at least one model
  const presentProviders = [...new Set(Object.keys(table).map(providerOf))].sort();

  // forward declaration so actions can reference mainMenu
  let mainMenu: MenuNode;

  const actions: MenuAction[] = [
    {
      key: '1', label: `查看所有模型定价（${Object.keys(table).length} 款）`,
      run: async () => ({
        output: [
          `\x1b[1m所有模型 GCC 定价\x1b[0m  (每百万 token)`, LINE,
          ...Object.entries(table).sort((a, b) => a[0].localeCompare(b[0]))
            .map(([m, p]) => formatModelLine(m, p)),
        ],
      }),
    },
  ];

  // one entry per provider
  let keyIdx = 2;
  for (const prov of presentProviders) {
    const count = Object.keys(table).filter(m => providerOf(m) === prov).length;
    const k = String(keyIdx++);
    const capProv = prov;
    actions.push({
      key: k, label: `${capProv} 系列（${count} 款）`,
      run: async () => ({ output: [], next: providerMenu(table, capProv, () => mainMenu) }),
    });
  }

  // cost estimator
  const estimateKey = String(keyIdx++);
  actions.push({
    key: estimateKey, label: '估算费用（模型 + token 数 → GCC）',
    run: async () => ({
      output: [],
      next: calcMenu(table, () => mainMenu),
      // switch to free-text input mode
      prompt: '请输入 <模型名> <输入量> <输出量>，例: claude-haiku-4-5 1m 200k',
      handler: async (input: string) => {
        const parts = input.trim().split(/\s+/);
        if (parts.length < 3) {
          return { output: ['格式: 模型名 输入量 输出量  (例: claude-haiku-4-5 1000000 200000)'] };
        }
        const [model, rawIn, rawOut] = parts;
        const inTok = parseTokens(rawIn), outTok = parseTokens(rawOut);
        if (inTok === null || outTok === null) {
          return { output: ['token 数格式不对，支持: 1000, 10k, 1m'] };
        }
        const price = table[model];
        if (!price) {
          const close = Object.keys(table).filter(m => m.includes(model.split('-')[0])).slice(0, 5);
          return { output: [`找不到模型 "${model}"`, ...(close.length ? [`类似模型: ${close.join(', ')}`] : [])] };
        }
        const inCost = (inTok * price.gcc_per_million_input) / 1_000_000;
        const outCost = (outTok * price.gcc_per_million_output) / 1_000_000;
        const total = inCost + outCost;
        return {
          output: [
            `\x1b[1m费用估算 — ${model}\x1b[0m`, LINE,
            `  输入: ${fmtN(inTok).padStart(13)} tokens × ${price.gcc_per_million_input} GCC/M = ${inCost.toFixed(4)} GCC`,
            `  输出: ${fmtN(outTok).padStart(13)} tokens × ${price.gcc_per_million_output} GCC/M = ${outCost.toFixed(4)} GCC`,
            LINE,
            `  合计: \x1b[1m${total.toFixed(4)} GCC\x1b[0m`,
            '',
            '(继续输入下一组，或选菜单)',
          ],
        };
      },
    }),
  });

  // farewell
  actions.push({ key: '0', label: '告辞', run: async () => ({ output: ['碧玄子: 慢走，有缘再会！'], exit: true }) });

  mainMenu = { title: '碧玄子 · 定价顾问', actions };
  return mainMenu;
}

// ── NPC menu registry ────────────────────────────────────────────────────────

export const menuRegistry = new Map<string, MenuNode>(); // npcId → root menu

/**
 * Register 碧玄子's pricing menu. Called after pricing data is fetched.
 * Safe to call multiple times (idempotent: replaces previous).
 */
export async function registerPricingMenu(client: AiggApiClient): Promise<void> {
  const PRICING_NPC_ID = 'npc:aigg:pricing-consultant';
  const table = await client.getGccPricing();
  menuRegistry.set(PRICING_NPC_ID, buildPricingMenu(table));
}
