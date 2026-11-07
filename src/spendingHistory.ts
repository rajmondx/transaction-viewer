import { periodEnd, type BalanceSpacing } from './balanceHistory';
import { UNCAT } from './categories/engine';
import type { Tx } from './types';

export interface SpendingTotals {
  income: number;
  expenses: number;
  net: number;
  transactions: number;
  categorizedAmount: number;
}
export interface SpendingDay extends SpendingTotals { date: string }
export interface SpendingPoint extends SpendingDay {
  from: string;
  excluded: boolean;
}
export const emptySpendingTotals = (): SpendingTotals => ({ income: 0, expenses: 0, net: 0, transactions: 0, categorizedAmount: 0 });

/** Use the report's direct assignments, never rolled-up parent totals. The caller
 * supplies its already source/date/cash-transfer-filtered aggregation. */
export function buildSpendingDays(
  txByTag: Map<string, Tx[]>, hiddenCats: string[], visibleMonths: string[], reconciliationCategory: string,
): SpendingDay[] {
  const hidden = new Set(hiddenCats), months = new Set(visibleMonths);
  const days = new Map<string, SpendingDay>();
  for (const [tag, txs] of txByTag) {
    if (hidden.has(tag)) continue;
    for (const tx of txs) {
      const date = tx.bookingDate || tx.valueDate;
      if (!date || !months.has(date.slice(0, 7))) continue;
      const day = days.get(date) ?? { date, ...emptySpendingTotals() };
      day.income += tx.credit;
      day.expenses += tx.debit;
      day.net += tx.credit - tx.debit;
      day.transactions++;
      if (tag !== UNCAT && tag !== reconciliationCategory) day.categorizedAmount += tx.debit;
      days.set(date, day);
    }
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function spendingCoverage(totals: SpendingTotals): number | null {
  return totals.expenses > 0 ? totals.categorizedAmount / totals.expenses * 100 : null;
}

/** Percentages must be expense-weighted, not the average of period percentages. */
export function sumSpending(points: SpendingTotals[]): SpendingTotals {
  const total = emptySpendingTotals();
  for (const point of points) {
    total.income += point.income;
    total.expenses += point.expenses;
    total.net += point.net;
    total.transactions += point.transactions;
    total.categorizedAmount += point.categorizedAmount;
  }
  return total;
}

const nextDay = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

function entirelyHidden(from: string, to: string, hidden: Set<string>): boolean {
  let month = from.slice(0, 7);
  while (month <= to.slice(0, 7)) {
    if (!hidden.has(month)) return false;
    const d = new Date(`${month}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    month = d.toISOString().slice(0, 7);
  }
  return true;
}

/** Flow totals per calendar period, not running balances. Inactive periods are
 * zero; explicitly hidden months are gaps, never fabricated zero spending. */
export function groupSpendingPeriods(
  days: SpendingDay[], spacing: BalanceSpacing, from: string, to: string, hiddenMonths: string[],
): SpendingPoint[] {
  if (!from || !to || from > to) return [];
  const hidden = new Set(hiddenMonths);
  const points: SpendingPoint[] = [];
  let index = 0;
  while (index < days.length && days[index].date < from) index++;
  for (let cursor = from; cursor <= to;) {
    const end = periodEnd(cursor, spacing);
    const date = end < to ? end : to;
    const total = emptySpendingTotals();
    while (index < days.length && days[index].date <= date) {
      const day = days[index++];
      if (hidden.has(day.date.slice(0, 7))) continue;
      total.income += day.income;
      total.expenses += day.expenses;
      total.net += day.net;
      total.transactions += day.transactions;
      total.categorizedAmount += day.categorizedAmount;
    }
    points.push({ ...total, from: cursor, date, excluded: entirelyHidden(cursor, date, hidden) });
    cursor = nextDay(date);
  }
  return points;
}
