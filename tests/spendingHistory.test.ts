import { describe, expect, it } from 'vitest';
import { buildSpendingDays, emptySpendingTotals, groupSpendingPeriods, spendingCoverage, sumSpending, type SpendingDay } from '../src/spendingHistory';
import type { Tx } from '../src/types';

function tx(id: string, date: string, amount: number): Tx {
  return { id, bookingDate: date, valueDate: '', file: 'test.csv', row: 1, ref: '', account: 'Main',
    accountAlias: '', iban: '', ibanDisplay: '', text: '', hay: '', credit: Math.max(0, amount), debit: Math.max(0, -amount) };
}
function day(date: string, income: number, expenses: number, categorizedAmount = expenses, transactions = 1): SpendingDay {
  return { date, income, expenses, categorizedAmount, transactions, net: income - expenses };
}

describe('Spending summary daily data', () => {
  it('uses direct assignments, respects hidden categories and months, and sorts dates', () => {
    const rows = new Map([
      ['Housing', [tx('mortgage', '2026-02-02', -20)]],
      ['Rent', [tx('rent', '2026-01-01', -100), tx('rent2', '2026-02-01', -100)]],
      ['Food', [tx('food', '2026-02-01', -5)]],
      ['Income', [tx('salary', '2026-02-01', 1000)]],
    ]);
    expect(buildSpendingDays(rows, ['Housing'], ['2026-02'], 'Corrections')).toEqual([
      day('2026-02-01', 1000, 105, 105, 3),
    ]);
    // Hiding a parent excludes its own transactions, not selected descendants.
    expect(sumSpending(buildSpendingDays(rows, ['Housing'], ['2026-01', '2026-02'], 'Corrections')).expenses).toBe(205);
  });

  it('counts income, cash and corrections, but treats Uncategorized and corrections as uncategorized expense value', () => {
    const days = buildSpendingDays(new Map([
      ['Income', [tx('income', '2026-01-01', 1000)]],
      ['Food', [tx('cash', '2026-01-01', -75)]],
      ['Uncategorized', [tx('unknown', '2026-01-01', -20)]],
      ['Corrections', [tx('correction', '2026-01-01', -5)]],
    ]), [], ['2026-01'], 'Corrections');
    expect(days).toEqual([day('2026-01-01', 1000, 100, 75, 4)]);
    expect(spendingCoverage(days[0])).toBe(75);
  });

  it('falls back to value dates and omits undated transactions', () => {
    const days = buildSpendingDays(new Map([['Food', [
      tx('undated', '', -500), { ...tx('value', '', -20), valueDate: '2026-01-02' },
    ]]]), [], ['', '2026-01'], 'Corrections');
    expect(days).toEqual([day('2026-01-02', 0, 20)]);
  });

  it('computes weighted coverage and returns no coverage without expenses', () => {
    const total = sumSpending([day('2026-01-01', 0, 100, 100), day('2026-02-01', 0, 900, 0)]);
    expect(spendingCoverage(total)).toBe(10); // not the unweighted 50%
    expect(spendingCoverage(day('2026-01-01', 500, 0))).toBeNull();
    expect(sumSpending([])).toEqual(emptySpendingTotals());
  });
});

describe('Spending period totals', () => {
  const days = [day('2024-02-28', 100, 20), day('2024-02-29', 0, 40), day('2024-04-02', 50, 80, 40, 2)];
  it('sums period flows instead of carrying balances forward', () => {
    const points = groupSpendingPeriods(days, 'Monthly', '2024-02-28', '2024-04-02', []);
    expect(points.map((p) => [p.from, p.date, p.income, p.expenses, p.net, p.transactions])).toEqual([
      ['2024-02-28', '2024-02-29', 100, 60, 40, 2],
      ['2024-03-01', '2024-03-31', 0, 0, 0, 0],
      ['2024-04-01', '2024-04-02', 50, 80, -30, 2],
    ]);
    expect(spendingCoverage(points[1])).toBeNull();
  });

  it('supports daily spacing, leap days and empty days', () => {
    const points = groupSpendingPeriods(days, 'Daily', '2024-02-28', '2024-03-01', []);
    expect(points.map((p) => [p.date, p.expenses])).toEqual([['2024-02-28', 20], ['2024-02-29', 40], ['2024-03-01', 0]]);
  });

  it('uses Monday–Sunday weeks and includes partial first/last periods', () => {
    const points = groupSpendingPeriods(days, 'Weekly', '2024-02-29', '2024-03-05', []);
    expect(points.map((p) => [p.from, p.date, p.expenses])).toEqual([
      ['2024-02-29', '2024-03-03', 40], ['2024-03-04', '2024-03-05', 0],
    ]);
  });

  it('groups calendar quarters and years and keeps net negative', () => {
    expect(groupSpendingPeriods(days, 'Quarterly', '2024-02-28', '2024-04-02', []).map((p) => [p.date, p.net])).toEqual([
      ['2024-03-31', 40], ['2024-04-02', -30],
    ]);
    expect(groupSpendingPeriods(days, 'Yearly', '2024-02-28', '2025-01-02', []).map((p) => [p.date, p.transactions])).toEqual([
      ['2024-12-31', 4], ['2025-01-02', 0],
    ]);
  });

  it('keeps explicitly hidden months as gaps and excludes their values from mixed periods', () => {
    const points = groupSpendingPeriods(days, 'Monthly', '2024-02-28', '2024-04-02', ['2024-02', '2024-03']);
    expect(points.map((p) => [p.excluded, p.expenses])).toEqual([[true, 0], [true, 0], [false, 80]]);
    expect(groupSpendingPeriods(days, 'Yearly', '2024-02-28', '2024-04-02', ['2024-02'])[0]).toMatchObject({
      excluded: false, income: 50, expenses: 80, net: -30, transactions: 2,
    });
  });

  it('excludes transactions outside exact custom-date boundaries', () => {
    const points = groupSpendingPeriods(days, 'Monthly', '2024-02-29', '2024-03-01', []);
    expect(sumSpending(points)).toEqual({ income: 0, expenses: 40, net: -40, categorizedAmount: 40, transactions: 1 });
  });

  it('handles no activity, invalid ranges and single-day ranges', () => {
    expect(groupSpendingPeriods([], 'Monthly', '', '', [])).toEqual([]);
    expect(groupSpendingPeriods(days, 'Monthly', '2025-01-01', '2024-01-01', [])).toEqual([]);
    expect(groupSpendingPeriods([], 'Yearly', '2024-01-01', '2024-01-01', [])).toEqual([
      { ...emptySpendingTotals(), from: '2024-01-01', date: '2024-01-01', excluded: false },
    ]);
  });
});
