import type { Settings, Tx } from '../types';
import type { FinanceData } from './model';
import { minor } from './model';
import { allocationRows } from './reporting';
import { isCashTransfer } from '../cash';
import { matchTx } from '../categories/engine';

export function budgetActuals(rows: Tx[], data: FinanceData, settings: Settings, month: string): Map<string, number> {
  const cents = new Map<string, number>();
  for (const tx of allocationRows(rows, data, settings)) {
    if (tx.cashAdjustment || isCashTransfer(tx, settings) || !tx.bookingDate.startsWith(`${month}-`)) continue;
    let tag: string | null = matchTx(tx, settings);
    const seen = new Set<string>();
    while (tag && !seen.has(tag)) {
      seen.add(tag); cents.set(tag, (cents.get(tag) ?? 0) + minor(tx.debit));
      tag = settings.categories.find((c) => c.tag === tag)?.tagFather ?? null;
    }
  }
  return new Map([...cents].map(([tag, n]) => [tag, n / 100]));
}
