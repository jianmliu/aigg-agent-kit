/** Scaffold smoke. Run: pnpm --filter @onchainpal/cognition test:scaffold */
import assert from 'node:assert/strict';
import { PACKAGE } from '../index';
assert.equal(PACKAGE, '@onchainpal/cognition', 'barrel resolves');
console.log('ALL SCAFFOLD SMOKE TESTS PASSED ✅');
