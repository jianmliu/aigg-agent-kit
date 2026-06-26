export interface Loan { id: string; lender: string; borrower: string; principal: number; rate: number; due: number }
export interface Settlement { loanId: string; lender: string; borrower: string; owed: number; paid: number; defaulted: boolean }

export const LOAN_RATE = 0.1;
export const LOAN_TERM = 1;   // due on the borrower's next interaction (clock-agnostic — host supplies `now`)

/** Loan records + settlement. Pure: holds records only; the HOST owns balances and applies the transfers
 *  from the returned settlements. Clock-agnostic — `now`/`due` are opaque numbers the host interprets. */
export class LoanBook {
  private loans: Loan[] = [];
  private seq = 0;

  lend(lender: string, borrower: string, opts: { principal: number; rate?: number; term?: number }, now: number): Loan {
    const loan: Loan = {
      id: `loan${this.seq++}`, lender, borrower,
      principal: opts.principal, rate: opts.rate ?? LOAN_RATE, due: now + (opts.term ?? LOAN_TERM),
    };
    this.loans.push(loan);
    return loan;
  }

  /** Matured-but-unsettled loans (for the host to know there's work). */
  due(now: number): Loan[] { return this.loans.filter((l) => l.due <= now); }

  /** Settle every matured loan: owed = principal*(1+rate); paid = clamp(min(owed, balanceOf(borrower)));
   *  defaulted = paid < owed. REMOVES settled loans (no double-default). */
  settle(now: number, balanceOf: (id: string) => number): Settlement[] {
    const matured = this.loans.filter((l) => l.due <= now);
    this.loans = this.loans.filter((l) => l.due > now);
    return matured.map((l) => {
      const owed = l.principal * (1 + l.rate);
      const paid = Math.max(0, Math.min(owed, balanceOf(l.borrower)));
      return { loanId: l.id, lender: l.lender, borrower: l.borrower, owed, paid, defaulted: paid < owed };
    });
  }
}
