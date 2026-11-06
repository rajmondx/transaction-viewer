import { describe, expect, it } from 'vitest';
import { allTransactionRows, calculateCashBalances, cashEntryTx, isCashTransfer, isUncountedCashTransfer, matchesTransactionSource, movementOf, RECONCILIATION_CATEGORY, uniqueReconciliationCategory } from '../src/cash';
import { aggregate } from '../src/categories/engine';
import { emptySettings } from '../src/categories/schema';
import { parseSettings, serializeSettings } from '../src/categories/schema';
import type { CashEntry, Settings, Tx } from '../src/types';

const settings: Settings = {
  name: 'test',
  categories: [
    { tag: 'ATM', tagFather: null, color: '#123456', ibans: [], rules: [{ text: 'atm', caseSensitive: false, fuzzy: false, regex: false }], dateFrom: null, dateTo: null, enabled: true, cashMovement: 'withdrawal' },
    { tag: 'Deposit', tagFather: null, color: '#654321', ibans: [], rules: [{ text: 'deposit', caseSensitive: false, fuzzy: false, regex: false }], dateFrom: null, dateTo: null, enabled: true, cashMovement: 'deposit' },
  ],
};

function bankTx(text: string, debit: number, credit = 0): Tx {
  return { id: text, file: 'statement.csv', row: 1, bookingDate: '2026-04-03', valueDate: '', ref: '', account: '', accountAlias: '', iban: '', ibanDisplay: '', text, hay: text.toLowerCase(), credit, debit };
}

describe('cash tracking', () => {
  it('round-trips category cash movement settings', () => {
    const restored = parseSettings(serializeSettings(settings), 'test');
    expect(restored.categories.map((c) => c.cashMovement)).toEqual(['withdrawal', 'deposit']);
    expect(parseSettings('{"categories":[{"tag":"Old"}]}', 'old').categories[0].cashMovement).toBeNull();
  });

  it('recognizes marked bank transfers but not ordinary transactions', () => {
    const withdrawal = bankTx('ATM withdrawal', 80);
    const deposit = bankTx('cash deposit', 0, 30);
    const other = bankTx('coffee', 5);
    expect(movementOf(withdrawal, settings)?.type).toBe('withdrawal');
    expect(movementOf(deposit, settings)?.type).toBe('deposit');
    expect(isCashTransfer(withdrawal, settings)).toBe(true);
    expect(isCashTransfer(other, settings)).toBe(false);
  });

  it('shows cash transfers in Spending but only counts them when included', () => {
    const withdrawal = bankTx('ATM withdrawal', 80);
    const other = bankTx('coffee', 5);
    // excluded by default: shown in the report input, not counted
    expect(isUncountedCashTransfer(withdrawal, settings, new Set())).toBe(true);
    expect(isUncountedCashTransfer(other, settings, new Set())).toBe(false);
    // once the user includes the category, it counts like any other row
    expect(isUncountedCashTransfer(withdrawal, settings, new Set(['ATM']))).toBe(false);
    // manual cash entries are never transfers — they are the spending itself
    const manual = cashEntryTx({ id: 'cash-row', date: '2026-04-02', kind: 'expense', amount: 2, category: 'Food', note: '' });
    expect(isUncountedCashTransfer(manual, settings, new Set())).toBe(false);
  });

  it('filters by bank origin or cash activity, keeping marked transfers in both views', () => {
    const withdrawal = bankTx('ATM withdrawal', 80);
    const ordinary = bankTx('coffee', 5);
    const manual = cashEntryTx({ id: 'cash-row', date: '2026-04-02', kind: 'expense', amount: 2, category: 'Food', note: '' });

    expect(matchesTransactionSource(withdrawal, 'cash', settings)).toBe(true);
    expect(matchesTransactionSource(withdrawal, 'bank', settings)).toBe(true);
    expect(matchesTransactionSource(ordinary, 'cash', settings)).toBe(false);
    expect(matchesTransactionSource(ordinary, 'bank', settings)).toBe(true);
    expect(matchesTransactionSource(manual, 'cash', settings)).toBe(true);
    expect(matchesTransactionSource(manual, 'bank', settings)).toBe(false);
    expect(matchesTransactionSource(manual, 'both', settings)).toBe(true);
  });

  it('calculates wallet balances after withdrawals, deposits, cash entries and corrections', () => {
    const withdrawal = { ...bankTx('ATM withdrawal', 30), bookingDate: '2026-04-01' };
    const ordinary = { ...bankTx('coffee', 5), bookingDate: '2026-04-02' };
    const deposit = { ...bankTx('cash deposit', 0, 10), bookingDate: '2026-04-04' };
    const entries: CashEntry[] = [
      { id: 'expense', date: '2026-04-03', kind: 'expense', amount: 5, category: 'Food', note: '' },
      { id: 'correction', date: '2026-04-05', kind: 'adjustment', amount: 2, category: '', note: '' },
    ];
    const balances = calculateCashBalances([withdrawal, ordinary, deposit], entries, settings, 20);

    expect(balances.get(withdrawal.id)).toBe(50);
    expect(balances.has(ordinary.id)).toBe(false);
    expect(balances.get('cash:expense')).toBe(45);
    expect(balances.get(deposit.id)).toBe(35);
    expect(balances.get('cash:correction')).toBe(37);
  });

  it('turns a manual cash expense into a categorized transaction for Spending', () => {
    const entry: CashEntry = { id: 'one', date: '2026-04-02', kind: 'expense', amount: 12.5, category: 'Food', note: 'Lunch' };
    const tx = cashEntryTx(entry);
    expect(tx.debit).toBe(12.5);
    expect(tx.credit).toBe(0);
    expect(tx.manualCategory).toBe('Food');
    expect(allTransactionRows([bankTx('coffee', 5)], [entry]).map((t) => t.id)).toEqual(['coffee', 'cash:one']);
  });

  it('keeps reconciliation corrections signed and assigns their virtual report category', () => {
    const entry: CashEntry = { id: 'reconcile', date: '2026-04-02', kind: 'adjustment', amount: -7.5, category: 'Uncategorized', note: 'Counted cash correction' };
    const tx = cashEntryTx(entry);
    expect(tx.debit).toBe(7.5);
    expect(tx.credit).toBe(0);
    expect(tx.cashAdjustment).toBe(true);
    expect(tx.manualCategory).toBe(RECONCILIATION_CATEGORY);
    const settings = emptySettings('test');
    settings.categories.push({
      tag: RECONCILIATION_CATEGORY, tagFather: null, color: '#999999', ibans: [], rules: [],
      dateFrom: null, dateTo: null, enabled: true,
    });
    const report = aggregate([tx], settings);
    expect(report.own.get(RECONCILIATION_CATEGORY)?.get('2026-04')?.debit).toBe(7.5);
  });

  it('chooses a distinct reconciliation category when the user already has the reserved name', () => {
    const settings = emptySettings('test');
    settings.categories.push({
      tag: RECONCILIATION_CATEGORY, tagFather: null, color: '#123456', ibans: [],
      rules: [{ text: 'ordinary', caseSensitive: false, fuzzy: false, regex: false }],
      dateFrom: null, dateTo: null, enabled: true,
    });
    const reportCategory = uniqueReconciliationCategory(settings);
    expect(reportCategory).toBe(`${RECONCILIATION_CATEGORY} (2)`);
    const adjustment = cashEntryTx({
      id: 'adjustment', date: '2026-04-03', kind: 'adjustment', amount: 1, category: '', note: '',
    }, reportCategory);
    expect(adjustment.manualCategory).toBe(reportCategory);
    expect(settings.categories[0].tag).toBe(RECONCILIATION_CATEGORY);
  });
});
