/**
 * Smoke — the three legs of a verifiable, Base-settled, AI-driven execution layer:
 *   EXECUTION  WorldStf.applyTx  — deterministic (fraud-proof)        [world-stf.smoke]
 *   AI         AttestationVerifier — TEE/operator-attested oracle output (anti-forgery)
 *   VALUE      SettlementLayer    — Base = canonical settlement (GCC conserved)
 *
 * This file covers the AI + VALUE legs and shows them composing with the STF:
 * an attested oracle output → verified → committed as an applyTalk tx; deposits/
 * withdrawals reconcile with Base and conserve GCC.
 *
 * Run: tsx src/__tests__/verifiable-execution.smoke.ts
 */
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { DefaultGameRules } from '@aigg/npc-agent';
import type { NpcPersona, Effect } from '@aigg/npc-agent';
import { OperatorAttestationVerifier, signAttestation, verifyTalkProvenance, sha256Hex } from '../stf/attestation-verifier';
import { BaseSettlementLayer } from '../stf/settlement-layer';
import { applyTx, applyAll, emptyWorld, relKey, type WorldTx } from '../stf/world-stf';

const OP_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const; // anvil#0 — a test operator
const NPC = 'npc:酒剑仙';
const persona = (id: string): NpcPersona => ({ id, name: '酒剑仙', role: '剑客', allowedEffects: ['adjustRelationship'], caps: { relationshipDeltaPerTurn: 15 } } as NpcPersona);
const rules = new DefaultGameRules(persona);

async function main() {
  const operator = privateKeyToAccount(OP_KEY).address;

  // ── AI leg: attest an oracle response, verify provenance, commit via STF ─────
  const response = JSON.stringify({ say: '论剑！', effects: [{ kind: 'adjustRelationship', delta: 6, reason: '论剑' }], emotion: '欣赏' });
  const effects: Effect[] = [{ kind: 'adjustRelationship', delta: 6, reason: '论剑' }];
  const att = await signAttestation({ model: 'claude', prompt: 'P', response, signerKey: OP_KEY });
  const verifier = new OperatorAttestationVerifier([operator]);

  const good = await verifyTalkProvenance({ attestation: att, response, effects }, verifier);
  assert.ok(good.ok, 'genuine attested response → provenance verifies');
  assert.equal(good.signer, operator.toLowerCase(), 'recovered the operator signer');
  console.log('  ✓ AI: attested oracle output verifies (signer recovered)');

  // forge attempts → rejected
  const wrongSigner = await verifyTalkProvenance({ attestation: att, response, effects }, new OperatorAttestationVerifier(['0x000000000000000000000000000000000000dead']));
  assert.equal(wrongSigner.ok, false); assert.equal(wrongSigner.reason, 'signer_not_allowed');
  const tampered = await verifyTalkProvenance({ attestation: att, response: response.replace('论剑', '伪造'), effects }, verifier);
  assert.equal(tampered.ok, false); assert.equal(tampered.reason, 'response_hash_mismatch');
  const fabricated = await verifyTalkProvenance({ attestation: att, response, effects: [{ kind: 'adjustRelationship', delta: 99, reason: 'x' }] }, verifier);
  assert.equal(fabricated.ok, false); assert.equal(fabricated.reason, 'effects_mismatch');
  console.log('  ✓ AI: forgery rejected (wrong signer / tampered response / fabricated effects)');

  // verified effects → deterministic applyTalk tx → STF
  const seed: WorldTx[] = [{ type: 'createNpc', id: NPC, name: '酒剑仙', owner: 'A', room: '酒馆', background: '剑客' }, { type: 'donate', npcId: NPC, amountGcc: 0.01 }];
  const s0 = applyAll(emptyWorld(), seed, rules).state;
  const committed = applyTx(s0, { type: 'applyTalk', npcId: NPC, playerId: 'V', effects, gccCost: 0.0003, now: 1 }, rules).state;
  assert.equal(committed.relationships[relKey(NPC, 'V')].affinity, 6, 'verified effects committed via STF');
  console.log('  ✓ AI→EXECUTION: verified oracle output → deterministic applyTalk → STF');

  // ── VALUE leg: Base = canonical settlement; GCC conserved; reconciles ────────
  // fake Base reader (TbaBalanceProvider stand-in) → balanceOf anchor
  const baseReader = { balanceGcc: async (id: string) => (id === NPC ? 0.5 : null) };
  const settle = new BaseSettlementLayer(baseReader);

  const approx = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  // THE conservation invariant: Σ execution balances == Base custody (no minting).
  // (display floats → within epsilon; production uses integer GCC atoms = exact.)
  const conserved = () => assert.ok(approx(settle.domainTotal(), settle.custodyTotal()), 'GCC conserved: domain total == Base custody (no minting)');

  await settle.deposit(NPC, 0.5);           // Base deposit credits execution layer
  await settle.deposit('npc:乙', 0.3);
  assert.ok(approx(settle.domainTotal(), 0.8), 'deposits credited');
  conserved();

  const w = await settle.withdraw(NPC, 0.2); // withdraw debits + releases on Base
  assert.ok(w.ok);
  assert.ok(approx(settle.domainTotal(), 0.6), 'withdraw debited');
  conserved();
  const over = await settle.withdraw(NPC, 999);
  assert.equal(over.ok, false); assert.equal(over.reason, 'insufficient');

  // reconciliation anchor: balanceOf reads canonical Base balance
  assert.equal(await settle.balanceOf(NPC), 0.5, 'balanceOf = canonical Base (TBA balanceOf), not the local ledger');
  assert.equal(await settle.balanceOf('npc:unminted'), 0, 'no on-chain → falls back (Base-compatible)');

  // state-root anchoring to Base inbox (on-chain post = TODO)
  await settle.anchor(sha256Hex('state-root-1'));
  assert.equal(settle.anchorCount(), 1, 'state root anchored (Base inbox stub)');
  console.log('  ✓ VALUE: Base = canonical settlement · GCC conserved (no mint) · reconciles with balanceOf');

  console.log('\nVERIFIABLE-EXECUTION (AI-attest + Base-settlement legs) SMOKE PASSED ✅');
}

main().catch((err) => { console.error('VERIFIABLE-EXECUTION SMOKE FAILED ❌', err); process.exit(1); });
