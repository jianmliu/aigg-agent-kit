/** Scaffold smoke. Run: pnpm --filter @onchainpal/cognition test:scaffold */
import assert from 'node:assert/strict';
import { corpusId, corpusPath, FakeKernel, TrustLedger, Cognition, shouldRefuse, diffuseWarning, AiggMemoryKernel, InMemoryKV } from '../index';
assert.equal(typeof corpusId, 'function', 'barrel exports corpusId');
assert.equal(typeof corpusPath, 'function', 'barrel exports corpusPath');
assert.equal(typeof FakeKernel, 'function', 'barrel exports FakeKernel');
assert.equal(typeof TrustLedger, 'function', 'barrel exports TrustLedger');
assert.equal(typeof Cognition, 'function', 'barrel exports Cognition');
assert.equal(typeof shouldRefuse, 'function', 'barrel exports shouldRefuse');
assert.equal(typeof diffuseWarning, 'function', 'barrel exports diffuseWarning');
assert.equal(typeof AiggMemoryKernel, 'function', 'barrel exports AiggMemoryKernel');
assert.equal(typeof InMemoryKV, 'function', 'barrel exports InMemoryKV');
console.log('ALL SCAFFOLD SMOKE TESTS PASSED ✅');
