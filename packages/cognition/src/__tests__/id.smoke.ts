/** Smoke for the canonical id transform. Run: pnpm --filter @onchainpal/cognition test:id */
import assert from 'node:assert/strict';
import { corpusId, corpusPath } from '../id';

assert.equal(corpusId('npc:0gtown:abao'), 'npc_0gtown_abao', 'colons sanitized');
assert.equal(corpusId('npc_0gtown_abao'), 'npc_0gtown_abao', 'idempotent');
assert.equal(corpusPath('npc:0gtown:abao'), 'npcs/npc_0gtown_abao/memory', 'corpus path wraps the id');
assert.notEqual(corpusId('npc:0gtown:abao'), corpusId('npc:0gtown:liu'), 'distinct ids stay distinct');
console.log('ALL ID SMOKE TESTS PASSED ✅');
