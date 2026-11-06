/** One bank transaction parsed from the CSV. */
export interface Tx {
  /** stable dedup id: hash of txId|iban|credit|debit (fallback iban|date|amount|text when no txId) */
  id: string;
  /** source csv file name */
  file: string;
  /** 1-based data row in the source file */
  row: number;
  /** ISO yyyy-mm-dd */
  bookingDate: string;
  /** ISO yyyy-mm-dd (may be '' when unparsable) */
  valueDate: string;
  ref: string;
  account: string;
  accountAlias: string;
  /** normalized: uppercase, no spaces */
  iban: string;
  /** original display value with spaces */
  ibanDisplay: string;
  /** Buchungstext, newlines replaced by " ⏐ " for display */
  text: string;
  /** Buchungstext collapsed whitespace (lower not applied) used for matching */
  hay: string;
  credit: number;
  /** stored as positive magnitude */
  debit: number;
  /** Present on manually entered cash transactions, never on imported bank rows. */
  cashEntryId?: string;
  manualCategory?: string;
  /** Reconciliation corrections affect cash balance, not Spending totals. */
  cashAdjustment?: boolean;
}

export interface CashEntry {
  id: string;
  /** ISO yyyy-mm-dd */
  date: string;
  kind: 'expense' | 'income' | 'adjustment';
  /** Positive expense/income magnitude; signed balance delta for adjustments. */
  amount: number;
  category: string;
  note: string;
}

/** One search rule inside a category. */
export interface SearchRule {
  text: string;
  caseSensitive: boolean;
  fuzzy: boolean;
  regex: boolean;
}

export interface Category {
  tag: string;
  tagFather: string | null;
  color: string;
  ibans: string[];
  rules: SearchRule[];
  /** ISO yyyy-mm-dd or null */
  dateFrom: string | null;
  dateTo: string | null;
  enabled: boolean;
  /** Marks a bank category as cash moved between bank and wallet, not spending. */
  cashMovement?: 'withdrawal' | 'deposit' | null;
}

/** One CSV schema = how a bank's columns map onto the internal transaction fields. */
export interface MapperColumns {
  /** required — transaction booking date */
  bookingDate: string;
  /** required — transaction description */
  text: string;
  /** transaction id used for dedup across overlapping exports (e.g. Auftragsnummer) */
  txId?: string;
  valueDate?: string;
  iban?: string;
  /** split-amount style: separate credit / debit columns */
  credit?: string;
  debit?: string;
  /** single signed amount column (negative = expense) — used when no credit/debit columns */
  amount?: string;
  account?: string;
  accountAlias?: string;
}

export interface Mapper {
  /** schema name, e.g. 'Alternative Bank Schweiz' */
  name: string;
  columns: MapperColumns;
}

/** Category settings bundle — mappers are separate (see storage/mappers.ts). */
export interface Settings {
  /** settings name, 'default' is the seeded settings bundle */
  name: string;
  categories: Category[];
}

export interface SettingsFileInfo {
  name: string;
  isDefault: boolean;
}

export interface CsvFileInfo {
  name: string;
  rows: number;
  /** schema the file was uploaded with ('' = needs remapping) */
  mapper: string;
}

/** month key 'yyyy-mm' */
export type Month = string;

export interface Agg {
  debit: number;
  credit: number;
  count: number;
}
