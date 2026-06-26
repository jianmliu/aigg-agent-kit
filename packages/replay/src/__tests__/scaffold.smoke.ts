/**
 * Scaffold smoke — proves the package resolves and runs under tsx.
 * Run: pnpm --filter @aigg/replay test:scaffold
 */
import assert from 'node:assert/strict';
import { SCHEMA_ID } from '../index';

assert.equal(SCHEMA_ID, 'replay@1', 'barrel resolves');
console.log('ALL SCAFFOLD SMOKE TESTS PASSED ✅');
