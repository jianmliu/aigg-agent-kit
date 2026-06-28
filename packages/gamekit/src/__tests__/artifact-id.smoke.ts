import assert from 'node:assert/strict'
import { artifactId } from '../stf/artifact-types.js'

// deterministic: same inputs → same id, replayable
assert.equal(
  artifactId('npc:cragheart:urist', 3, 1280),
  artifactId('npc:cragheart:urist', 3, 1280),
  'artifactId is deterministic',
)
// distinct inputs → distinct ids
assert.notEqual(artifactId('npc:cragheart:urist', 3, 1280), artifactId('npc:cragheart:dokan', 3, 1280))
assert.notEqual(artifactId('npc:cragheart:urist', 3, 1280), artifactId('npc:cragheart:urist', 4, 1280))
// shape: 'art:' + 16 hex
const id = artifactId('npc:cragheart:urist', 3, 1280)
assert.match(id, /^art:[0-9a-f]{16}$/, `id shape, got ${id}`)

console.log('artifact-id.smoke.ts: PASS')
