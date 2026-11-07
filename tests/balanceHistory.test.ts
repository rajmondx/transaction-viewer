import { describe, expect, it } from 'vitest';
import { balanceRangeStart, buildBalanceHistory, sampleBalanceHistory, type BalancePoint } from '../src/balanceHistory';
import { emptySettings } from '../src/categories/schema';
import type { Tx } from '../src/types';

function tx(id: string, date: string, amount: number, text = '', account = 'Main'): Tx {
  return {
    id, bookingDate: date, valueDate: '', file: 'test.csv', row: 1, ref: '', account,
    accountAlias: account, iban: '', ibanDisplay: '', text, hay: text.toLowerCase(),
    credit: Math.max(0, amount), debit: Math.max(0, -amount),
  };
}
const point = (date: string, total: number): BalancePoint => ({ date, total, bank: total - 10, cash: 10 });

describe('balance history', () => {
  it('preserves total through withdrawals and deposits, and includes cash purchases and corrections', () => {
    const settings = emptySettings('test');
    settings.categories.push(...(['withdrawal', 'deposit'] as const).map((kind) => ({
      tag: kind, tagFather: null, color: '#000', ibans: [],
      rules: [{ text: kind, caseSensitive: false, fuzzy: false, regex: false }],
      dateFrom: null, dateTo: null, enabled: true, cashMovement: kind,
    })));
    const history = buildBalanceHistory([
      tx('salary', '2026-01-01', 50), tx('withdrawal', '2026-01-02', -30, 'withdrawal'),
      tx('deposit', '2026-01-03', 10, 'deposit'),
    ], [
      { id: 'food', date: '2026-01-04', amount: 5, kind: 'expense', category: 'Food', note: '' },
      { id: 'fix', date: '2026-01-05', amount: -2, kind: 'adjustment', category: '', note: '' },
    ], settings, 20, { 'account:main': { date: '2026-01-01', amount: 100 } });
    expect(history).toEqual([
      { date: '2026-01-01', total: 170, cash: 20, bank: 150 },
      { date: '2026-01-02', total: 170, cash: 50, bank: 120 },
      { date: '2026-01-03', total: 170, cash: 40, bank: 130 },
      { date: '2026-01-04', total: 165, cash: 35, bank: 130 },
      { date: '2026-01-05', total: 163, cash: 33, bank: 130 },
    ]);
  });

  it('uses later opening anchors backwards and counts accounts with no transactions', () => {
    const history = buildBalanceHistory([
      tx('a', '2026-01-01', 30), tx('b', '2026-01-02', -10), tx('c', '2026-01-02', 5, '', 'Other'),
    ], [], emptySettings('test'), 10, {
      'account:main': { date: '2026-01-02', amount: 100 },
      'account:unloaded': { date: '2026-01-01', amount: 40 },
    });
    expect(history).toEqual([
      { date: '2026-01-01', total: 150, bank: 140, cash: 10 },
      { date: '2026-01-02', total: 145, bank: 135, cash: 10 },
    ]);
  });

  it('keeps only the final same-day balance, falls back to value date, and omits undated rows', () => {
    const history = buildBalanceHistory([
      tx('undated', '', 999), { ...tx('a', '', 20), valueDate: '2026-01-01' },
      tx('b', '2026-01-01', -5), tx('c', '2026-01-02', 3),
    ], [], emptySettings('test'), 0, {});
    expect(history).toEqual([
      { date: '2026-01-01', total: 15, cash: 0, bank: 15 },
      { date: '2026-01-02', total: 18, cash: 0, bank: 18 },
    ]);
  });

  it('supports cash-only history and empty history', () => {
    expect(buildBalanceHistory([], [], emptySettings('test'), 20, {})).toEqual([]);
    expect(buildBalanceHistory([], [
      { id: 'cash', kind: 'expense', date: '2026-01-01', amount: 25, category: '', note: '' },
    ], emptySettings('test'), 20, {})).toEqual([{ date: '2026-01-01', total: -5, bank: 0, cash: -5 }]);
  });
});

describe('balance point spacing', () => {
  const history = [point('2024-02-27', 100), point('2024-02-29', 80), point('2024-04-02', 150)];
  it('carries balances across inactive and leap days', () => {
    expect(sampleBalanceHistory(history, 'Daily', '2024-02-27', '2024-03-01')).toEqual([
      point('2024-02-27', 100), point('2024-02-28', 100), point('2024-02-29', 80), point('2024-03-01', 80),
    ]);
  });
  it('samples Sunday week ends and the final partial week', () => {
    expect(sampleBalanceHistory(history, 'Weekly', '2024-02-27', '2024-03-05')).toEqual([
      point('2024-03-03', 80), point('2024-03-05', 80),
    ]);
  });
  it('uses closing balances, not sums, and carries forward missing months', () => {
    expect(sampleBalanceHistory(history, 'Monthly', '2024-02-27', '2024-04-02')).toEqual([
      point('2024-02-29', 80), point('2024-03-31', 80), point('2024-04-02', 150),
    ]);
  });
  it('uses calendar quarters and years with partial final periods', () => {
    expect(sampleBalanceHistory(history, 'Quarterly', '2024-02-27', '2024-04-02')).toEqual([
      point('2024-03-31', 80), point('2024-04-02', 150),
    ]);
    expect(sampleBalanceHistory(history, 'Yearly', '2024-02-27', '2025-01-03')).toEqual([
      point('2024-12-31', 150), point('2025-01-03', 150),
    ]);
  });
  it('keeps pre-range movements in balances and handles single points and invalid ranges', () => {
    expect(sampleBalanceHistory(history, 'Monthly', '2024-03-01', '2024-04-02')).toEqual([
      point('2024-03-31', 80), point('2024-04-02', 150),
    ]);
    expect(sampleBalanceHistory(history, 'Yearly', '2024-04-02', '2024-04-02')).toEqual([point('2024-04-02', 150)]);
    expect(sampleBalanceHistory(history, 'Daily', '2025-01-01', '2024-01-01')).toEqual([]);
    expect(sampleBalanceHistory(history, 'Daily', '2024-01-01', '2024-01-02')).toEqual([]);
    expect(sampleBalanceHistory([], 'Daily', '2024-01-01', '2024-01-02')).toEqual([]);
  });
  it('clamps month presets at month ends and at the first available date', () => {
    expect(balanceRangeStart('2024-03-31', 1, '2020-01-01')).toBe('2024-02-29');
    expect(balanceRangeStart('2025-03-31', 1, '2020-01-01')).toBe('2025-02-28');
    expect(balanceRangeStart('2024-02-29', 12, '2020-01-01')).toBe('2023-02-28');
    expect(balanceRangeStart('2024-03-31', 12, '2024-02-01')).toBe('2024-02-01');
  });
});
