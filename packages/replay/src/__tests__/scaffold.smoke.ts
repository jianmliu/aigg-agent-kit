/**
 * Scaffold smoke — proves the package resolves and runs under tsx.
 * Run: pnpm --filter @onchainpal/replay test:scaffold
 */
import assert from 'node:assert/strict';
import { PACKAGE } from '../index';

assert.equal(PACKAGE, '@onchainpal/replay', 'barrel resolves');
console.log('ALL SCAFFOLD SMOKE TESTS PASSED ✅');
