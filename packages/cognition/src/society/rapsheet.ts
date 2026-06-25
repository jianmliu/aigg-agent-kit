export interface RapEntry { kind: string; victim: string; t: number }   // kind: 'default' (②c-1); 'extort'/'sabotage' in ②c-2

/** A public misconduct ledger — the grounds a guild reads when sanctioning. Pure, in-memory. */
export class RapSheet {
  private sheet = new Map<string, RapEntry[]>();

  record(offender: string, entry: RapEntry): void {
    const list = this.sheet.get(offender);
    if (list) list.push(entry);
    else this.sheet.set(offender, [entry]);
  }

  entries(offender: string): RapEntry[] { return this.sheet.get(offender) ?? []; }
  has(offender: string): boolean { return (this.sheet.get(offender)?.length ?? 0) > 0; }
  count(offender: string): number { return this.sheet.get(offender)?.length ?? 0; }
}
