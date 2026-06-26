/**
 * Smoke for PackRegistry + defaultRegistry.
 * Run: pnpm --filter @aigg/replay test:registry
 */
import assert from 'node:assert/strict';
import { PackRegistry, defaultRegistry } from '../registry';
import type { ReplayPack } from '../schema';

const reg = defaultRegistry();
assert.ok(reg.has('core@0'), 'core preloaded');
assert.ok(reg.has('town@0'), 'town preloaded');
assert.ok(reg.has('econ@0'), 'econ preloaded');
assert.equal(reg.get('nope'), undefined, 'unknown pack → undefined');

// eventKinds unions across requested packs
const kinds = reg.eventKinds(['core@0', 'town@0']);
assert.ok(kinds.has('say'), 'core say included');
assert.ok(kinds.has('town.talk'), 'town.talk included');
assert.ok(!kinds.has('econ.pump'), 'econ excluded when not requested');

// custom registry is isolated
const custom = new PackRegistry();
const fake: ReplayPack = { id: 'x@0', eventKinds: ['x.go'] };
custom.register(fake);
assert.ok(custom.has('x@0') && !custom.has('town@0'), 'custom registry isolated');

console.log('ALL REGISTRY SMOKE TESTS PASSED ✅');
