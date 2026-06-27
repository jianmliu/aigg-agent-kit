import assert from 'node:assert/strict'
import { applyTx, type WorldState, type WorldTx } from '../stf/world-stf.js'
import { DefaultGameRules } from '@onchainpal/npc-agent'
import type { ArtifactProvenance } from '../stf/artifact-types.js'

function baseState(): WorldState {
  return {
    npcs: { 'npc:u': { id: 'npc:u', name: 'Urist', owner: 'sys', room: 'r:forge', background: '', status: 'active' } as any },
    registry: ['npc:u'], balances: {}, relationships: {}, flags: {},
  }
}
const prov: ArtifactProvenance = {
  creatorNpcId: 'npc:u', deedSeq: 12, worldId: 'dwarf', season: 1, createdAt: 1000, tba: '0xabc',
}
const tx: WorldTx = {
  type: 'forgeArtifact', npcId: 'npc:u', artifactId: 'art:deadbeefdeadbeef', kind: 'statue',
  name: '岩心之泪', engraving: '此器铭 Urist 于矿脉斩哥布林', materialsSilver: 40, provenance: prov, now: 1000,
}

// 1. forges: writes artifacts + inventory, emits artifactForged
{
  const { state, events } = applyTx(baseState(), tx, new DefaultGameRules(() => undefined))
  const rec = state.artifacts?.['art:deadbeefdeadbeef']
  assert.ok(rec, 'artifact recorded')
  assert.equal(rec!.ownedBy, 'npc:u')
  assert.equal(rec!.onchain, true)
  assert.equal(rec!.name, '岩心之泪')
  assert.deepEqual(state.inventory?.['npc:u'], ['art:deadbeefdeadbeef'], 'pushed to inventory')
  const ev = events.find((e) => (e as any).kind === 'artifactForged') as any
  assert.ok(ev && ev.artifactId === 'art:deadbeefdeadbeef' && ev.artifactKind === 'statue', 'artifactForged emitted')
}

// 2. unknown npc → rejected, no artifact
{
  const s = baseState(); delete (s.npcs as any)['npc:u']
  const { state, events } = applyTx(s, tx, new DefaultGameRules(() => undefined))
  assert.equal(state.artifacts?.['art:deadbeefdeadbeef'], undefined)
  assert.ok(events.some((e) => (e as any).kind === 'rejected'), 'rejected on no npc')
}

// 3. replayable: same input → same output
{
  const a = applyTx(baseState(), tx, new DefaultGameRules(() => undefined))
  const b = applyTx(baseState(), tx, new DefaultGameRules(() => undefined))
  assert.deepEqual(a.state.artifacts, b.state.artifacts)
}

console.log('forge-artifact-stf.smoke.ts: PASS')
