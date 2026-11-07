import type { Mapper, MapperColumns, Tx } from '../types';
import { fnv1a } from '../ui/util';

/**
 * Decode CSV bytes: try strict UTF-8, fall back to windows-1252
 * (bank exports like the SHKB/ABS one in example/ are cp1252).
 */
export function decodeSmart(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** RFC-4180 CSV parser: quoted fields, escaped quotes, embedded newlines, CRLF, BOM. */
export function parseCsvRecords(text: string): string[][] {
  let s = text;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      pushField();
      i++;
      continue;
    }
    if (c === '\r') {
      if (s[i + 1] === '\n') i++;
      pushRow();
      i++;
      continue;
    }
    if (c === '\n') {
      pushRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== '' || row.length > 0) pushRow();
  // drop fully empty trailing rows
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

/**
 * Parse bank amounts like 'CHF -500.00', 'CHF -1,600.00', 'CHF 6,361.75', '54.30'.
 * Returns a signed number or null when empty/unparsable.
 */
export function parseAmount(s: string | undefined): number | null {
  if (!s) return null;
  let t = s.trim().replace(/^CHF\s*/i, '').replace(/\s/g, '').replace(/[’'.]/g, (m) => (m === '.' ? '.' : ''));
  if (t === '') return null;
  // When both separators occur, the last one is decimal (1,234.56 / 1.234,56).
  if (t.includes(',') && t.includes('.')) {
    t = t.lastIndexOf(',') > t.lastIndexOf('.')
      ? t.replace(/\./g, '').replace(/,/g, '.')
      : t.replace(/,/g, '');
  } else if (t.includes(',')) t = t.replace(/,/g, '.'); // only comma -> decimal comma
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function isoOrNull(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null; // e.g. 31.02
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 'DD.MM.YYYY' (or 'D.M.YYYY') -> 'YYYY-MM-DD' or null. Calendar-valid only. */
export function parseDateDE(s: string | undefined): string | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  return isoOrNull(Number(m[3]), Number(m[2]), Number(m[1]));
}

/** Tolerant date parsing for arbitrary banks: DD.MM.YYYY, DD/MM/YYYY, DD-MM-YYYY, ISO YYYY-MM-DD. */
export function parseDateAuto(s: string | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  const iso = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (iso) return isoOrNull(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const dmy = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (dmy) return isoOrNull(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));
  return null;
}

export function normalizeIban(s: string): string {
  return s.replace(/\s+/g, '').toUpperCase();
}

export interface BankCsvParseResult {
  txs: Tx[];
  warnings: string[];
  /** required mapper columns missing from the header — non-empty means the file does not match the schema */
  missing: string[];
}

/**
 * Stable dedup id. Overlapping bank exports (e.g. monthly statements re-listing
 * boundary transactions) must produce the same id for the same payment:
 *   primary key = transaction id + account identity + amounts (so different amounts stay separate,
 *   while text/date differences merge — see csv/dedupe.ts)
 *   account identity = IBAN, or normalized account/alias when no IBAN is mapped;
 *   fallback (rows without a transaction id) = account identity + date + amounts + text.
 */
export function makeTxId(ref: string, iban: string, booking: string, credit: number, debit: number, hay: string): string {
  const amt = `${credit.toFixed(2)}|${debit.toFixed(2)}`;
  if (ref) return fnv1a(`T|${ref}|${iban}|${amt}`);
  return fnv1a(`F|${iban}|${booking}|${amt}|${hay}`);
}

/** Parse a CSV into transactions using a schema mapper (column names → Tx fields). */
export function parseWithMapper(text: string, fileName: string, mapper: Mapper): BankCsvParseResult {
  const warnings: string[] = [];
  const records = parseCsvRecords(text);
  if (records.length < 2) {
    warnings.push(`${fileName}: file has no data rows`);
    return { txs: [], warnings, missing: [] };
  }
  const header = records[0].map((c) => c.trim());
  const lower = header.map((c) => c.toLowerCase());
  const idx: Partial<Record<keyof MapperColumns, number>> = {};
  for (const key of Object.keys(mapper.columns) as Array<keyof MapperColumns>) {
    const col = mapper.columns[key];
    if (!col) continue;
    const i = lower.indexOf(col.trim().toLowerCase());
    if (i >= 0) idx[key] = i;
  }
  const has = (k: keyof MapperColumns) => idx[k] !== undefined;
  const get = (r: string[], k: keyof MapperColumns) => (has(k) ? (r[idx[k]!] ?? '') : '');

  const missing: string[] = [];
  if (!has('bookingDate')) missing.push(`${mapper.columns.bookingDate || 'booking date'} (required)`);
  if (!has('text')) missing.push(`${mapper.columns.text || 'description'} (required)`);
  if (!has('credit') && !has('debit') && !has('amount')) missing.push('credit / debit / amount column (required)');
  if (missing.length > 0) {
    warnings.push(`${fileName}: columns missing for schema "${mapper.name}" — headers: ${header.join(', ')}`);
    return { txs: [], warnings, missing };
  }

  const txs: Tx[] = [];
  for (let i = 1; i < records.length; i++) {
    const r = records[i];
    const rawText = get(r, 'text');
    const booking = parseDateAuto(get(r, 'bookingDate'));
    if (!booking && !rawText) {
      warnings.push(`row ${i + 1}: skipped (no date, no text)`);
      continue;
    }
    let credit = 0;
    let debit = 0;
    if (has('amount') && !has('credit') && !has('debit')) {
      const n = parseAmount(get(r, 'amount'));
      if (n != null) {
        credit = n > 0 ? n : 0;
        debit = n < 0 ? -n : 0;
      }
    } else {
      const cRaw = has('credit') ? parseAmount(get(r, 'credit')) : null;
      const dRaw = has('debit') ? parseAmount(get(r, 'debit')) : null;
      // credit/debit columns are magnitudes in their own column, sign style varies by bank
      credit = cRaw != null ? Math.abs(cRaw) : 0;
      debit = dRaw != null ? Math.abs(dRaw) : 0;
    }
    if (!booking) warnings.push(`row ${i + 1}: unparsable date '${get(r, 'bookingDate')}'`);
    const ibanDisplay = has('iban') ? get(r, 'iban') : '';
    const iban = normalizeIban(ibanDisplay);
    const ref = has('txId') ? get(r, 'txId').trim() : '';
    const hay = rawText.replace(/\s+/g, ' ').trim();
    const account = has('account') ? get(r, 'account').trim() : '';
    const accountAlias = has('accountAlias') ? get(r, 'accountAlias').trim() : '';
    // Non-IBAN exports still need an account-scoped dedup key. Keep the
    // original IBAN key unchanged when available, including across mappers.
    const identity = iban || (account ? `account:${account.toLowerCase()}` : accountAlias ? `alias:${accountAlias.toLowerCase()}` : '');
    const id = makeTxId(ref, identity, booking ?? '', credit, debit, hay);
    txs.push({
      id,
      file: fileName,
      row: i + 1,
      bookingDate: booking ?? '',
      valueDate: has('valueDate') ? parseDateAuto(get(r, 'valueDate')) ?? '' : '',
      ref,
      account,
      accountAlias,
      iban,
      ibanDisplay,
      text: rawText.replace(/\r/g, '').replace(/\n/g, ' ⏐ ').trim(),
      hay,
      credit,
      debit,
    });
  }
  return { txs, warnings, missing: [] };
}
