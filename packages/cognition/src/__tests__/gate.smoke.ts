/** Smoke for shouldRefuse. Run: pnpm --filter @onchainpal/cognition test:gate */
import assert from 'node:assert/strict';
import { shouldRefuse } from '../gate';
import type { CognitiveSignal } from '../types';

const sig = (q: number, trust: number): CognitiveSignal => ({
  discernment: { q, faculty: q ? 1 : 0, social: 0, confidence: q ? 0.5 : 0 },
  trust, beliefs: { units: [], bundle: '', total: 0 }, summary: '',
});

assert.equal(shouldRefuse(sig(1, 0)).refuse, true, 'q over threshold → refuse');
assert.equal(shouldRefuse(sig(0, -0.9)).refuse, true, 'trust under floor → refuse');
assert.equal(shouldRefuse(sig(0, 0)).refuse, false, 'neutral → allow');
assert.ok(shouldRefuse(sig(1, 0)).reason, 'refusal carries a reason');
console.log('ALL GATE SMOKE TESTS PASSED ✅');
