import type { Tx } from '../types';
import { fuzzyIn } from '../categories/engine';

export interface CsvFilter {
  source: 'cash' | 'bank' | 'both';
  text: string;
  caseSensitive: boolean;
  fuzzy: boolean;
  minAmount: string;
  maxAmount: string;
  dateFrom: string;
  dateTo: string;
  direction: 'all' | 'income' | 'expense';
  /** selected category tags (empty = all categories) */
  selectedCats: string[];
}

export function defaultCsvFilter(): CsvFilter {
  return {
    source: 'both',
    text: '',
    caseSensitive: false,
    fuzzy: false,
    minAmount: '',
    maxAmount: '',
    dateFrom: '',
    dateTo: '',
    direction: 'all',
    selectedCats: [],
  };
}

export function txAmount(tx: Tx): number {
  return tx.credit > 0 ? tx.credit : tx.debit;
}

/** Does the raw query match this haystack with the given toggles? (used on several fields) */
export function queryMatches(query: string, hay: string, caseSensitive: boolean, fuzzy: boolean): boolean {
  if (query === '') return true;
  const q = caseSensitive ? query : query.toLowerCase();
  const h = caseSensitive ? hay : hay.toLowerCase();
  return fuzzy ? fuzzyIn(h, q) : h.includes(q);
}

/**
 * Read an amount the user typed into the min/max boxes. Handles the groupings
 * people actually type: `1'234.56`, `1,234.56`, `1.234,56`, `1234,56`, plain
 * numbers. A lone comma is the decimal separator (DACH convention), a lone dot
 * followed by exactly three digits is a thousands separator.
 */
export function parseAmountInput(raw: string): number | null {
  const t = raw.replace(/[\s'’]/g, '');
  if (t === '' || t === '.' || t === ',' || t === '-') return null;
  const lastComma = t.lastIndexOf(',');
  const lastDot = t.lastIndexOf('.');
  let normalized = t;
  if (lastComma >= 0 && lastDot >= 0) {
    // both present: the LAST one is the decimal separator
    normalized = lastComma > lastDot ? t.replace(/\./g, '').replace(/,/g, '.') : t.replace(/,/g, '');
  } else if (lastComma >= 0) {
    normalized = t.replace(/,/g, '.');
  } else if (/\d\.\d{3}(\.\d{3})*$/.test(t)) {
    normalized = t.replace(/\./g, '');
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

export function filterTxs(
  txs: Tx[],
  f: CsvFilter,
  categoryOf: (tx: Tx) => string,
  sourceMatches: (tx: Tx, source: CsvFilter['source']) => boolean = (tx, source) =>
    source === 'both' || (source === 'cash' ? Boolean(tx.cashEntryId) : !tx.cashEntryId),
): Tx[] {
  const min = parseAmountInput(f.minAmount);
  const max = parseAmountInput(f.maxAmount);
  return txs.filter((tx) => {
    if (!sourceMatches(tx, f.source)) return false;
    if (f.direction === 'income' && tx.credit <= 0) return false;
    if (f.direction === 'expense' && tx.debit <= 0) return false;
    if (f.dateFrom && tx.bookingDate && tx.bookingDate < f.dateFrom) return false;
    if (f.dateTo && tx.bookingDate && tx.bookingDate > f.dateTo) return false;
    if (min !== null && Number.isFinite(min) && txAmount(tx) < min) return false;
    if (max !== null && Number.isFinite(max) && txAmount(tx) > max) return false;
    if (f.selectedCats.length > 0 && !f.selectedCats.includes(categoryOf(tx))) return false;
    if (f.text !== '') {
      const ok =
        queryMatches(f.text, tx.hay, f.caseSensitive, f.fuzzy) ||
        queryMatches(f.text, tx.ref, f.caseSensitive, f.fuzzy) ||
        queryMatches(f.text, tx.iban, f.caseSensitive, f.fuzzy) ||
        queryMatches(f.text, tx.ibanDisplay, f.caseSensitive, f.fuzzy) ||
        queryMatches(f.text, tx.account + ' ' + tx.accountAlias, f.caseSensitive, f.fuzzy);
      if (!ok) return false;
    }
    return true;
  });
}

/** Escape HTML then wrap case-aware matches of `q` in <mark>. Fuzzy/regex-style skipped. */
export function highlight(text: string, q: string, caseSensitive: boolean): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (q === '') return esc;
  const flags = caseSensitive ? 'g' : 'gi';
  let re: RegExp;
  try {
    re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  } catch {
    return esc;
  }
  return esc.replace(re, (m) => '<mark class="bg-amber-200 px-px text-inherit dark:bg-amber-400/30">' + m + '</mark>');
}
