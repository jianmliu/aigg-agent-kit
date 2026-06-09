/**
 * claude-cli-provider smoke — encodes the E1-real lesson as a regression test.
 *
 * The load-bearing fix (from aigg-memory's E1-real): `claude -p` is agentic, so
 * the extractor system prompt must be an OVERRIDE (`--system-prompt`) + dynamic
 * sections dropped — NOT `--append-system-prompt` (which loses to the persona and
 * yields conversational replies that don't parse to NPC effects). This test locks
 * those flags in (no live `claude` call — an injected runner).
 *
 * Run: tsx src/__tests__/claude-cli-provider.smoke.ts
 */
import assert from 'node:assert/strict';
import { ClaudeCliProvider, parseAgentIntent } from '../index';

async function main() {
  let captured: { args: string[]; stdin: string } | null = null;
  const fakeRun = (out: string) => (args: string[], stdin: string) => { captured = { args, stdin }; return Promise.resolve(out); };

  // ── the fix is locked in: override, not append; drop dynamic sections ───────
  const cleanJson = '{"say":"欢迎,我这有把好剑。","effects":[{"kind":"adjustRelationship","delta":5,"reason":"礼貌的顾客"}]}';
  const p = new ClaudeCliProvider({ model: 'haiku', run: fakeRun(cleanJson) });
  const res = await p.complete({ prompt: '玩家说:你好,我想买把剑。', system: '只输出 JSON: {say, effects}' });
  const a = captured.args;
  assert.ok(a.includes('-p'), 'headless -p');
  assert.ok(a.includes('--system-prompt'), 'system is an OVERRIDE (--system-prompt)');
  assert.ok(a.includes('--exclude-dynamic-system-prompt-sections'), 'dynamic sections dropped (CLAUDE.md/env)');
  assert.ok(!a.includes('--append-system-prompt'), 'NEVER --append (loses to the agentic persona)');
  assert.equal(a[a.indexOf('--system-prompt') + 1], '只输出 JSON: {say, effects}', 'request.system is the override text');
  assert.ok(a.includes('--model') && a[a.indexOf('--model') + 1] === 'haiku', 'model passed');
  assert.equal(captured.stdin, '玩家说:你好,我想买把剑。', 'prompt rides on stdin');
  console.log('  ✓ flags: -p + --system-prompt(override) + --exclude-dynamic-... + --model; prompt on stdin; never --append');

  // ── with the fix, a clean structured reply parses to NPC effects ────────────
  assert.equal(res.usage?.model, 'haiku'); assert.ok((res.usage?.gccCost ?? 0) >= 0);
  const ok = parseAgentIntent(res.text);
  assert.ok(ok.ok && ok.intent?.effects?.[0]?.kind === 'adjustRelationship', 'override → clean JSON → parses to effects (E1-real green)');
  console.log('  ✓ override path: claude returns clean JSON → parseAgentIntent → adjustRelationship effect');

  // ── the gotcha documented: a conversational reply (the old failure) does NOT parse ──
  const chatty = "I see you're looking for a sword! What kind of blade did you have in mind?";
  const p2 = new ClaudeCliProvider({ run: fakeRun(chatty) });
  const res2 = await p2.complete({ prompt: 'x' });
  const bad = parseAgentIntent(res2.text);
  assert.ok(!(bad.ok && bad.intent?.effects?.length), 'conversational reply → no parseable effects (the failure --append would cause)');
  console.log('  ✓ gotcha locked: a conversational reply yields no effects → why the override matters');

  console.log('\nCLAUDE-CLI-PROVIDER SMOKE PASSED ✅');
}

main().catch((e) => { console.error('CLAUDE-CLI-PROVIDER SMOKE FAILED ❌', e); process.exit(1); });
