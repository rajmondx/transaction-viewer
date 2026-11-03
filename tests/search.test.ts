import { describe, expect, it } from 'vitest';
import type { Tx } from '../src/types';
import { defaultCsvFilter, filterTxs, highlight, parseAmountInput, queryMatches } from '../src/ui/search';

function tx(partial: Partial<Tx>): Tx {
  return {
    id: 'x', file: 'f', row: 1, bookingDate: '2026-10-05', valueDate: '', ref: 'R1',
    account: 'Alltagskonto', accountAlias: 'Alltagskonto', iban: 'CH89', ibanDisplay: 'CH89',
    text: 'Einkauf Migros', hay: 'Einkauf Migros', credit: 0, debit: 12.6, ...partial,
  };
}

describe('queryMatches', () => {
  it('case-insensitive contains by default', () => {
    expect(queryMatches('migros', 'Einkauf Migros', false, false)).toBe(true);
    expect(queryMatches('Migros', 'einkauf migros', true, false)).toBe(false);
    expect(queryMatches('migros', 'Einkauf Migros', true, false)).toBe(false);
  });
  it('fuzzy subsequence', () => {
    expect(queryMatches('mgro', 'Einkauf Migros', false, true)).toBe(true);
    expect(queryMatches('zzz', 'Einkauf Migros', false, true)).toBe(false);
  });
});

describe('parseAmountInput', () => {
  it('reads the groupings people type into the amount filter', () => {
    expect(parseAmountInput('1234')).toBe(1234);
    expect(parseAmountInput('1234.56')).toBe(1234.56);
    expect(parseAmountInput('1234,56')).toBe(1234.56);
    expect(parseAmountInput('1’234.56')).toBe(1234.56);
    expect(parseAmountInput('1 234,56')).toBe(1234.56);
    expect(parseAmountInput('1.234,56')).toBe(1234.56);
    expect(parseAmountInput('1,234.56')).toBe(1234.56);
    expect(parseAmountInput('1.234')).toBe(1234); // German thousands
    expect(parseAmountInput('1.234.567')).toBe(1234567);
  });
  it('returns null instead of NaN on blanks and leftovers', () => {
    expect(parseAmountInput('')).toBeNull();
    expect(parseAmountInput(' ')).toBeNull();
    expect(parseAmountInput('.')).toBeNull();
    expect(parseAmountInput('abc')).toBeNull();
  });
});

describe('filterTxs', () => {
  const txs = [
    tx({ ref: 'A1', hay: 'Migros', debit: 50, bookingDate: '2026-10-01' }),
    tx({ ref: 'A2', hay: 'Miete Oktober', credit: 1600, debit: 0, bookingDate: '2026-09-01' }),
    tx({ ref: 'A3', hay: 'LIDL sagt danke', debit: 200, bookingDate: '2026-08-15' }),
  ];
  const catOf = () => 'Uncategorized';

  it('amount range filters by magnitude', () => {
    const f = { ...defaultCsvFilter(), minAmount: '100', maxAmount: '' };
    expect(filterTxs(txs, f, catOf, 'Uncategorized').map((t) => t.ref)).toEqual(['A2', 'A3']);
  });
  it('date range', () => {
    const f = { ...defaultCsvFilter(), dateFrom: '2026-09-01', dateTo: '2026-10-01' };
    expect(filterTxs(txs, f, catOf, 'Uncategorized').map((t) => t.ref)).toEqual(['A1', 'A2']);
  });
  it('direction', () => {
    expect(filterTxs(txs, { ...defaultCsvFilter(), direction: 'income' }, catOf, 'Uncategorized').map((t) => t.ref)).toEqual(['A2']);
    expect(filterTxs(txs, { ...defaultCsvFilter(), direction: 'expense' }, catOf, 'Uncategorized').map((t) => t.ref)).toEqual(['A1', 'A3']);
  });
  it('multi-category selection', () => {
    const catOf = (t: Tx) => (t.ref === 'A1' ? 'Lebensmittel' : t.ref === 'A2' ? 'Einkommen' : 'Uncategorized');
    const f = { ...defaultCsvFilter(), selectedCats: ['Lebensmittel', 'Uncategorized'] };
    expect(filterTxs(txs, f, catOf, 'Uncategorized').map((t) => t.ref)).toEqual(['A1', 'A3']);
    const f2 = { ...defaultCsvFilter(), selectedCats: [] };
    expect(filterTxs(txs, f2, catOf, 'Uncategorized')).toHaveLength(3);
  });
  it('text search searches ref and iban too', () => {
    expect(filterTxs(txs, { ...defaultCsvFilter(), text: 'A3' }, catOf, 'Uncategorized').map((t) => t.ref)).toEqual(['A3']);
  });
  it('combined: case-sensitive + amount + fuzzy', () => {
    const f = { ...defaultCsvFilter(), text: 'LIDL', caseSensitive: true, minAmount: '190' };
    expect(filterTxs(txs, f, catOf, 'Uncategorized').map((t) => t.ref)).toEqual(['A3']);
    const f2 = { ...defaultCsvFilter(), text: 'lidl', minAmount: '210' };
    expect(filterTxs(txs, f2, catOf, 'Uncategorized')).toHaveLength(0);
  });
});

describe('highlight', () => {
  it('wraps matches, escapes html', () => {
    expect(highlight('Einkauf Migros', 'migros', false)).toContain('<mark class="bg-amber-200 px-px text-inherit dark:bg-amber-400/30">Migros</mark>');
    expect(highlight('<script>x</script>', 'x', false)).toContain('&lt;script&gt;<mark');
    expect(highlight('abc', '', false)).toBe('abc');
  });
});
