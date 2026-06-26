/** Smoke for LoanBook. Run: pnpm --filter @onchainpal/cognition test:lending */
import assert from 'node:assert/strict';
import { LoanBook } from '../society/lending';

// lend records a loan due at now+term (default term 1, rate 0.1)
const lb = new LoanBook();
const loan = lb.lend('npc:han', 'v', { principal: 10 }, 0);
assert.equal(loan.due, 1, 'due = now + term(1)');
assert.equal(loan.principal, 10);
assert.deepEqual(lb.due(0), [], 'not matured before due');
assert.equal(lb.due(1).length, 1, 'matured at due');
assert.deepEqual(lb.settle(0, () => 100), [], 'no settlement before due');

// funded borrower repays in full: owed = 10 * 1.1 = 11
const lb2 = new LoanBook();
lb2.lend('npc:han', 'v', { principal: 10 }, 0);
const s = lb2.settle(1, () => 100);
assert.equal(s.length, 1);
assert.ok(Math.abs(s[0].owed - 11) < 1e-9, 'owed = principal*(1+rate)');
assert.ok(Math.abs(s[0].paid - 11) < 1e-9, 'paid in full');
assert.equal(s[0].defaulted, false, 'funded → repaid');
assert.deepEqual(lb2.settle(2, () => 100), [], 'no double-settle (loan removed)');

// deadbeat (balance 0) → full default, paid clamped to 0
const lb3 = new LoanBook();
lb3.lend('npc:han', 'v', { principal: 10 }, 0);
const d = lb3.settle(1, () => 0);
assert.equal(d[0].defaulted, true, 'balance 0 → default');
assert.equal(d[0].paid, 0, 'paid clamped to 0');

// partial pay → still default, paid = balance
const lb4 = new LoanBook();
lb4.lend('npc:han', 'v', { principal: 10 }, 0);
const p = lb4.settle(1, () => 5);
assert.equal(p[0].defaulted, true, 'short → default');
assert.equal(p[0].paid, 5, 'partial paid = balance');

console.log('ALL LENDING SMOKE TESTS PASSED ✅');
