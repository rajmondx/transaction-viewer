import { describe, expect, it } from 'vitest';
import { calculateAccountBalances, groupBankAccounts } from '../src/bankBalances';
import type { Tx } from '../src/types';

function tx(id: string, date: string, amount: number, iban = 'CH9300762011623852957'): Tx {
  return {
    id, file: 'statement.csv', row: 1, bookingDate: date, valueDate: '', ref: '', account: '',
    accountAlias: 'Main account', iban, ibanDisplay: iban, text: id, hay: id.toLowerCase(),
    credit: Math.max(0, amount), debit: Math.max(0, -amount),
  };
}

describe('bank account opening balances', () => {
  it('calculates the running balance after each transaction from the opening date', () => {
    const rows = [tx('salary', '2026-01-02', 1000), tx('rent', '2026-01-03', -300)];
    const opening = { 'iban:CH9300762011623852957': { date: '2026-01-02', amount: 250 } };
    const balances = calculateAccountBalances(rows, opening);
    expect(balances.get('salary')).toBe(1250);
    expect(balances.get('rent')).toBe(950);
  });

  it('derives balances backwards from a later opening date and keeps accounts separate', () => {
    const rows = [tx('older', '2025-12-31', -5), tx('later', '2026-01-02', 10), tx('other', '2026-01-02', 40, 'CH5604835012345678009')];
    const openings = { 'iban:CH9300762011623852957': { date: '2026-01-01', amount: 80 } };
    const balances = calculateAccountBalances(rows, openings);
    expect(balances.get('older')).toBe(80);
    expect(balances.get('later')).toBe(90);
    expect(balances.get('other')).toBe(40);
    expect(groupBankAccounts(rows)).toHaveLength(2);
  });

  it('can derive earlier transaction balances from a later checkpoint', () => {
    const rows = [tx('credit', '2026-01-02', 100), tx('debit', '2026-01-03', -20)];
    const balances = calculateAccountBalances(rows, {
      'iban:CH9300762011623852957': { date: '2026-01-04', amount: 500 },
    });
    expect(balances.get('debit')).toBe(500);
    expect(balances.get('credit')).toBe(520);
  });
});
