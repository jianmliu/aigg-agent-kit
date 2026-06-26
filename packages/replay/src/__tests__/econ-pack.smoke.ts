/**
 * Smoke for the econ@0 stub pack — proves the neutral core can name the
 * pumptown/replay@0 event vocabulary. Full validation is deferred (monopoly's cycle).
 * Run: pnpm --filter @aigg/replay test:econ
 */
import assert from 'node:assert/strict';
import { econPack, ECON_PACK_ID } from '../packs/econ';

assert.equal(ECON_PACK_ID, 'econ@0');
assert.ok(econPack.eventKinds.includes('econ.pump'), 'has econ.pump');
assert.ok(econPack.eventKinds.includes('econ.dump'), 'has econ.dump');
assert.ok(econPack.eventKinds.includes('econ.blackswan'), 'has econ.blackswan');
assert.ok((econPack.viewer?.panels?.length ?? 0) >= 1, 'declares at least one panel');
// stub: no validation yet
assert.equal(econPack.validateEvent, undefined, 'econ validation deferred');

console.log('ALL ECON-PACK SMOKE TESTS PASSED ✅');
