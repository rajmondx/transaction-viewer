import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBalanceOverview, calculateCombinedBalances } from '../src/balanceOverview';
import { emptySettings } from '../src/categories/schema';
import type { CashEntry, Tx } from '../src/types';

const iban = 'CH9300762011623852957';
function tx(id: string, amount: number, category = ''): Tx {
  return {
    id, file: 'bank.csv', row: 1, bookingDate: '2026-01-02', valueDate: '', ref: '', account: '',
    accountAlias: 'Main', iban, ibanDisplay: iban, text: category, hay: category.toLowerCase(),
    credit: Math.max(0, amount), debit: Math.max(0, -amount),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('Spending balance overview', () => {
  it('includes bank and cash opening balances, transfers, expenses and reconciliation in total', () => {
    const storage = new Map<string, string>([['banking.accountOpeningBalances', JSON.stringify({
      [`iban:${iban}`]: { date: '2026-01-02', amount: 100 },
    })]]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });

    const settings = emptySettings('test');
    settings.categories.push({
      tag: 'Cash withdrawal', tagFather: null, color: '#000000', ibans: [iban],
      rules: [{ text: 'cash withdrawal', caseSensitive: false, fuzzy: false, regex: false }],
      dateFrom: null, dateTo: null, enabled: true, cashMovement: 'withdrawal',
    });
    const entries: CashEntry[] = [
      { id: 'expense', date: '2026-01-03', kind: 'expense', amount: 5, category: 'Food', note: '' },
      { id: 'adjustment', date: '2026-01-04', kind: 'adjustment', amount: 2, category: '', note: '' },
    ];
    const overview = buildBalanceOverview([
      tx('salary', 50), tx('withdrawal', -30, 'cash withdrawal'),
    ], entries, settings, 20);

    expect(overview.bankBalance).toBe(120);
    expect(overview.cashBalance).toBe(47); // 20 + 30 - 5 + 2
    expect(overview.corrections).toBe(2);
    expect(overview.combinedBalance).toBe(167);
  });

  it('counts an opening balance set for an account without imported rows', () => {
    const storage = new Map<string, string>([['banking.accountOpeningBalances', JSON.stringify({
      [`iban:${iban}`]: { date: '2026-01-02', amount: 100 },
      'iban:CH0000000000000000000': { date: '2026-01-02', amount: 30 },
    })]]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    const overview = buildBalanceOverview([tx('salary', 50)], [], emptySettings('test'), 0);
    expect(overview.bankBalance).toBe(180); // 150 + 30
    expect(overview.combinedBalance).toBe(180);
  });

  it('shows net movement estimates when bank accounts have no opening balances', () => {
    const overview = buildBalanceOverview(
      [tx('credit', 50), tx('debit', -12)], [], emptySettings('test'), 5,
    );
    expect(overview.bankBalance).toBe(38);
    expect(overview.cashBalance).toBe(5);
    expect(overview.combinedBalance).toBe(43);
    expect(overview.unanchoredAccounts).toEqual(['Main']);
  });
});

function datedTx(id: string, amount: number, date: string, text = '', txIban = iban): Tx {
  return {
    id, file: 'bank.csv', row: 1, bookingDate: date, valueDate: '', ref: '', account: '',
    accountAlias: 'Main', iban: txIban, ibanDisplay: txIban, text, hay: text.toLowerCase(),
    credit: Math.max(0, amount), debit: Math.max(0, -amount),
  };
}

describe('Combined cash + bank running balance', () => {
  const withdrawalSettings = () => {
    const settings = emptySettings('test');
    settings.categories.push({
      tag: 'Cash withdrawal', tagFather: null, color: '#000000', ibans: [iban],
      rules: [{ text: 'cash withdrawal', caseSensitive: false, fuzzy: false, regex: false }],
      dateFrom: null, dateTo: null, enabled: true, cashMovement: 'withdrawal',
    });
    return settings;
  };

  it('nets cash transfers to zero and follows wallet and bank movements', () => {
    const balances = calculateCombinedBalances(
      [datedTx('salary', 50, '2026-01-02'), datedTx('withdrawal', -30, '2026-01-03', 'cash withdrawal')],
      [
        { id: 'expense', date: '2026-01-04', kind: 'expense', amount: 5, category: 'Food', note: '' },
        { id: 'adjust', date: '2026-01-05', kind: 'adjustment', amount: 2, category: '', note: '' },
      ],
      withdrawalSettings(), 20,
      { [`iban:${iban}`]: { date: '2026-01-02', amount: 100 } },
    );
    expect(balances.get('salary')).toBe(170);       // bank 150 + wallet 20
    expect(balances.get('withdrawal')).toBe(170);   // bank 120 + wallet 50 — money only moved sides
    expect(balances.get('cash:expense')).toBe(165); // really spent from the wallet
    expect(balances.get('cash:adjust')).toBe(167);
  });

  it('counts an opening balance for an account without loaded rows', () => {
    const balances = calculateCombinedBalances(
      [datedTx('salary', 50, '2026-01-02')], [], emptySettings('test'), 0,
      {
        [`iban:${iban}`]: { date: '2026-01-02', amount: 100 },
        'iban:CH0000000000000000000': { date: '2026-01-02', amount: 30 },
      },
    );
    expect(balances.get('salary')).toBe(180); // 150 + 30
  });

  it('uses the same order for same-day cash entries and bank cash transfers', () => {
    const transfer = { ...datedTx('withdrawal', -30, '2026-01-03', 'cash withdrawal'), ref: 'A1' };
    const expense: CashEntry = { id: 'expense', date: '2026-01-03', kind: 'expense', amount: 5, category: 'Food', note: '' };
    const balances = calculateCombinedBalances(
      [transfer], [expense], withdrawalSettings(), 20,
      { [`iban:${iban}`]: { date: '2026-01-03', amount: 100 } },
    );

    // Cash has no order number, so it comes before the bank row in the shared
    // ascending order; the combined total remains 115 after either movement.
    expect(balances.get('cash:expense')).toBe(115);
    expect(balances.get('withdrawal')).toBe(115);
  });

  it('uses net movement for accounts without an opening balance', () => {
    const other = 'CH2904835000000000000';
    const balances = calculateCombinedBalances(
      [datedTx('a', 40, '2026-02-01', '', other), datedTx('b', -10, '2026-02-02', '', other)],
      [], emptySettings('test'), 0, {},
    );
    expect(balances.get('a')).toBe(40);
    expect(balances.get('b')).toBe(30);
  });

  it('orders same-day rows by Order no., so the newest displayed row carries the final total', () => {
    // a transfer pair and two purchases share one booking date; refs order them
    // legs-first, purchases-last — exactly what the date-sorted table shows
    const other = 'CH2904835000000000000';
    const legs = [
      { ...datedTx('to-sav', -1670, '2026-01-05', '', iban), ref: 'a1' },
      { ...datedTx('from-day', 1670, '2026-01-05', '', other), ref: 'a2' },
      { ...datedTx('migros', -5.2, '2026-01-05', '', iban), ref: 'b' },
      { ...datedTx('ellies', -41.44, '2026-01-05', '', iban), ref: 'c' },
    ];
    const balances = calculateCombinedBalances(
      legs, [], emptySettings('test'), 0,
      { [`iban:${iban}`]: { date: '2026-01-05', amount: 5000 }, [`iban:${other}`]: { date: '2026-01-05', amount: 0 } },
    );
    expect(balances.get('to-sav')).toBeCloseTo(3330, 2);      // debit leg before credit leg
    expect(balances.get('from-day')).toBeCloseTo(5000, 2);    // both legs applied — money only moved sides
    expect(balances.get('migros')).toBeCloseTo(4994.8, 2);
    expect(balances.get('ellies')).toBeCloseTo(4953.36, 2);   // last row = final total, same as the summary
  });
});
