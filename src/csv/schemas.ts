import type { Mapper, MapperColumns } from '../types';
import { parseCsvRecords } from './parse';

/**
 * Built-in CSV schemas ("mappers"). Each maps a bank's CSV columns onto the
 * internal transaction fields. Mappers live independently of category settings:
 * custom ones are saved in the mapper registry (storage/mappers.ts) and every
 * uploaded CSV file keeps a snapshot of the mapper chosen for it in the
 * upload modal.
 */

export const ABS_SCHEMA_NAME = 'Alternative Bank Schweiz';

/** The known ABS / Swiss-bank export layout (previously the only supported one). */
export const ABS_MAPPER: Mapper = {
  name: ABS_SCHEMA_NAME,
  columns: {
    bookingDate: 'Buchungsdatum',
    valueDate: 'Valutadatum',
    txId: 'Auftragsnummer',
    account: 'Konto',
    accountAlias: 'Kontoalias',
    iban: 'IBAN',
    text: 'Buchungstext',
    credit: 'Gutschrift',
    debit: 'Belastung',
  },
};

export const KNOWN_SCHEMAS: Mapper[] = [ABS_MAPPER];

export const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** first row of a CSV text = the header cells (trimmed, empties dropped) */
export function parseCsvHeaders(content: string): string[] {
  const records = parseCsvRecords(content);
  return (records[0] ?? []).map((c) => c.trim()).filter((c) => c !== '');
}

/** best mapper (from all known + saved mappers) whose required columns are all in the header */
export function detectBestMapper(headers: string[], candidates: Mapper[]): { mapper: Mapper; score: number } | null {
  let best: { mapper: Mapper; score: number } | null = null;
  for (const mapper of candidates) {
    if (missingColumns(headers, mapper).length > 0) continue;
    const score = scoreSchema(headers, mapper);
    if (!best || score > best.score) best = { mapper, score };
  }
  return best;
}

const absClone = (): Mapper => ({ name: ABS_MAPPER.name, columns: { ...ABS_MAPPER.columns } });

/** Tolerant mapper parse: { name, columns: {...} }; anything invalid → the built-in ABS schema. */
export function parseMapper(raw: unknown): Mapper {
  if (!raw || typeof raw !== 'object') return absClone();
  const o = raw as Record<string, unknown>;
  const colsRaw = (o.columns ?? {}) as Record<string, unknown>;
  const pick = (key: keyof MapperColumns): string => {
    const v = colsRaw[key];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : '';
  };
  const columns: MapperColumns = {
    bookingDate: pick('bookingDate'),
    text: pick('text'),
  };
  for (const key of ['txId', 'valueDate', 'iban', 'credit', 'debit', 'amount', 'account', 'accountAlias'] as const) {
    const v = pick(key);
    if (v) columns[key] = v;
  }
  if (!hasRequiredColumns(columns)) return absClone();
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : 'Custom';
  return { name, columns };
}

export function serializeMapper(m: Mapper): string {
  return JSON.stringify({ name: m.name, columns: m.columns }, null, 2);
}

/** internal fields shown in the mapping wizard, in priority order */
export const MAPPER_FIELDS: Array<{ key: keyof MapperColumns; label: string; required: boolean }> = [
  { key: 'bookingDate', label: 'Booking date', required: true },
  { key: 'text', label: 'Description', required: true },
  { key: 'credit', label: 'Credit (income)', required: false },
  { key: 'debit', label: 'Debit (expense)', required: false },
  { key: 'amount', label: 'Amount (signed, single column)', required: false },
  { key: 'txId', label: 'Transaction ID (dedup key)', required: false },
  { key: 'iban', label: 'IBAN', required: false },
  { key: 'valueDate', label: 'Value date', required: false },
  { key: 'account', label: 'Account', required: false },
  { key: 'accountAlias', label: 'Account alias', required: false },
];

/** true when the mapper can produce transactions: bookingDate + text + (credit|debit|amount) */
export function hasRequiredColumns(columns: MapperColumns): boolean {
  if (!columns.bookingDate || !columns.text) return false;
  return Boolean(columns.credit || columns.debit || columns.amount);
}

/** header cells that the mapper needs but the file does not have */
export function missingColumns(headers: string[], mapper: Mapper): string[] {
  const have = new Set(headers.map(norm));
  const missing: string[] = [];
  const need = (col: string | undefined, required: boolean) => {
    if (!col) return;
    if (!have.has(norm(col))) missing.push(`${col}${required ? ' (required)' : ''}`);
  };
  const c = mapper.columns;
  need(c.bookingDate, true);
  need(c.text, true);
  if (c.credit) need(c.credit, false);
  if (c.debit) need(c.debit, false);
  if (c.amount) need(c.amount, false);
  if (!c.credit && !c.debit && !c.amount) missing.push('credit / debit / amount column (required)');
  return missing;
}

/** fraction (0..1) of the mapper's defined columns that appear in the header */
export function scoreSchema(headers: string[], mapper: Mapper): number {
  const have = new Set(headers.map(norm));
  const cols = Object.values(mapper.columns).filter((v): v is string => Boolean(v));
  if (cols.length === 0) return 0;
  const found = cols.filter((c) => have.has(norm(c))).length;
  return found / cols.length;
}

/** best known schema whose required columns are all present, if any */
export function detectSchema(headers: string[]): { mapper: Mapper; score: number } | null {
  return detectBestMapper(headers, KNOWN_SCHEMAS);
}

/** name-similarity hints for guessing a custom mapping from unknown headers */
const SYNONYMS: Record<keyof MapperColumns, string[]> = {
  bookingDate: ['buchungsdatum', 'booking date', 'bookingdate', 'booked on', 'buchungsdatum (de)', 'datum', 'date', 'buchung', 'transaktionsdatum'],
  text: ['buchungstext', 'description', 'text', 'beschreibung', 'verwendungszweck', 'zahlungszweck', 'subject', 'memo', 'comment', 'details'],
  credit: ['gutschrift', 'credit', 'eingang', 'haben', 'credit amount', 'sollhaben'],
  debit: ['belastung', 'debit', 'ausgang', 'soll', 'debit amount'],
  amount: ['betrag', 'amount', 'valor', 'total', 'value'],
  txId: ['auftragsnummer', 'referenz', 'reference', 'transaction id', 'transaktionsnummer', 'mandatsreferenz', 'id', 'ref'],
  iban: ['iban', 'account iban', 'kontonummer', 'recipient iban'],
  valueDate: ['valutadatum', 'valuta', 'value date', 'valuedate', 'valuta datum'],
  account: ['konto', 'account', 'account name', 'kontoname', 'kontobezeichnung'],
  accountAlias: ['kontoalias', 'account alias', 'alias'],
};

function guessScore(header: string, synonyms: string[]): number {
  const h = norm(header);
  let best = 0;
  for (const s of synonyms) {
    if (h === s) best = Math.max(best, 3);
    else if (h.startsWith(s) || s.startsWith(h)) best = Math.max(best, 2);
    else if (h.includes(s)) best = Math.max(best, 1);
  }
  return best;
}

/** auto-guess a column mapping: greedily assign the best-matching unused header per field */
export function guessColumns(headers: string[]): MapperColumns {
  const out: MapperColumns = { bookingDate: '', text: '' };
  const used = new Set<number>();
  const order: Array<keyof MapperColumns> = [
    'bookingDate', 'text', 'credit', 'debit', 'amount', 'txId', 'iban', 'valueDate', 'account', 'accountAlias',
  ];
  for (const key of order) {
    let bestIdx = -1;
    let bestScore = 0;
    headers.forEach((hd, i) => {
      if (used.has(i)) return;
      const s = guessScore(hd, SYNONYMS[key]);
      if (s > bestScore) { bestScore = s; bestIdx = i; }
    });
    if (bestIdx >= 0 && bestScore > 0) {
      used.add(bestIdx);
      out[key] = headers[bestIdx].trim();
    }
  }
  return out;
}
