/** Smoke for the Polity proposal state machine. Run: pnpm --filter @aigg/cognition test:polity */
import assert from 'node:assert/strict';
import { Polity } from '../governance/polity';

async function main() {
  // submit seeds the proposer 'for'
  const p = new Polity();
  const pid = p.submit('a', 'sanction', { target: 'v' });
  assert.equal(p.get(pid)!.votes.get('a'), 'for', 'proposer pre-seeded for');

  // cast rejects self-vote, double-vote, unknown pid (no throw)
  p.cast(pid, 'a', 'against');
  assert.equal(p.get(pid)!.votes.get('a'), 'for', 'self-vote ignored');
  p.cast(pid, 'b', 'for');
  p.cast(pid, 'b', 'against');
  assert.equal(p.get(pid)!.votes.get('b'), 'for', 'double-vote ignored (first wins)');
  p.cast('nope', 'b', 'for'); // unknown pid → no throw

  // tally passes at >= threshold (a,b for, c against → 2/3 ≥ 0.6) and enacts the sanction
  const r = p.tally(pid, ['a', 'b', 'c']);
  assert.equal(r.passed, true, 'pass at 2/3');
  assert.ok(Math.abs(r.shareFor - 2 / 3) < 1e-9, 'shareFor = 2/3');
  assert.deepEqual(r.effect, { target: 'v', until: Infinity }, 'sanction enacted');
  assert.equal(p.get(pid), undefined, 'proposal removed after tally');
  assert.equal(p.sanctioned('v'), true, 'v sanctioned (until Infinity)');
  assert.equal(p.sanctioned('other'), false, 'unrelated target not sanctioned');

  // fails below threshold (1/3 < 0.6) → no sanction
  const p2 = new Polity();
  const pid2 = p2.submit('a', 'sanction', { target: 'v' });
  p2.cast(pid2, 'b', 'against');
  p2.cast(pid2, 'c', 'against');
  assert.equal(p2.tally(pid2, ['a', 'b', 'c']).passed, false, 'fail at 1/3');
  assert.equal(p2.sanctioned('v'), false, 'no sanction on a failed vote');

  // Math.max: a later finite `until` must NOT shorten an active (Infinity) ban
  const p3 = new Polity();
  p3.tally(p3.submit('a', 'sanction', { target: 'v', until: Infinity }), ['a']);
  p3.tally(p3.submit('a', 'sanction', { target: 'v', until: 5 }), ['a']);
  assert.equal(p3.sanctioned('v', 1000), true, 'Infinity ban not shortened by a later until:5');

  // finite until + now (strict >)
  const p4 = new Polity();
  p4.tally(p4.submit('a', 'sanction', { target: 'v', until: 10 }), ['a']);
  assert.equal(p4.sanctioned('v', 5), true, 'sanctioned before expiry');
  assert.equal(p4.sanctioned('v', 10), false, 'not sanctioned at expiry (strict >)');

  // pluggable enactor for a non-built-in ptype
  const p5 = new Polity({ enactors: { tax: (payload) => ({ taxed: payload.rate }) } });
  assert.deepEqual(p5.tally(p5.submit('a', 'tax', { rate: 0.1 }), ['a']).effect, { taxed: 0.1 }, 'custom enactor ran');

  // unknown ptype with no enactor → passes, effect undefined, no throw
  const p6 = new Polity();
  const r6 = p6.tally(p6.submit('a', 'mystery', {}), ['a']);
  assert.equal(r6.passed, true);
  assert.equal(r6.effect, undefined, 'unknown ptype enacts to no-op');

  // threshold honored (custom 1.0 needs unanimity)
  const p7 = new Polity({ threshold: 1.0 });
  const id7 = p7.submit('a', 'sanction', { target: 'v' });
  p7.cast(id7, 'b', 'against');
  assert.equal(p7.tally(id7, ['a', 'b']).passed, false, 'unanimity threshold not met');

  console.log('ALL POLITY SMOKE TESTS PASSED ✅');
}
main().catch((e) => { console.error('POLITY SMOKE FAILED ❌', e); process.exit(1); });
