/**
 * Smoke — the shipped fixture must validate, guarding the schema contract.
 * Run: pnpm --filter @aigg/replay test:fixture
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { validateFile } from '../index';

const fixture = fileURLToPath(new URL('../../fixtures/0gtown-sample.jsonl', import.meta.url));
const res = validateFile(fixture);
assert.equal(res.ok, true, `fixture validates: ${JSON.stringify(res.errors)}`);
console.log('ALL FIXTURE SMOKE TESTS PASSED ✅');
