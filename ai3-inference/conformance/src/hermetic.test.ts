/**
 * The V1 gate (extraction plan T7) — boots the full hermetic stack and
 * asserts EVERY matrix check passes:
 *
 *   local chain → deploy (legacy type-0) → fake DSN → mock dstack quote →
 *   stub gateway → register → broker complete() → dstack:verified:<id> →
 *   matrix green, including the negative/tamper cases and the dcap column.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHermetic } from './hermetic.js';
import { renderMatrix } from './matrix.js';

test('hermetic conformance matrix is fully green (milestone V1)', { timeout: 300_000 }, async () => {
  const result = await runHermetic();
  const rendered = renderMatrix(result);
  console.log(rendered);

  for (const g of result.groups) {
    assert.ok(g.ok, `group ${g.group} failed:\n${rendered}`);
    if (!g.skipped) assert.ok(g.checks.length > 0, `group ${g.group} ran no checks`);
  }
  // the hermetic stack provides a funded lifecycle key and a dcap fixture —
  // NO group may be skipped here (a live read-only run may skip lifecycle).
  assert.deepEqual(result.groups.filter((g) => g.skipped).map((g) => g.group), []);
  assert.equal(result.ok, true);
  // every invariant group from the plan is present.
  assert.deepEqual(
    result.groups.map((g) => g.group).sort(),
    ['cost-nonzero', 'dcap', 'quote-binding', 'registry-lifecycle', 'response-signature', 'streaming-trailer', 'tier-label-guard'],
  );
});
