import type { CashEntry, Category, Settings, Tx } from './types';
import { matchTx } from './categories/engine';

/** Virtual Spending category reserved for dated cash reconciliation corrections. */
export const RECONCILIATION_CATEGORY = 'Uncategorized Reconciliations';

/** Pick a report-only reconciliation tag without shadowing a user category. */
export function uniqueReconciliationCategory(settings: Settings): string {
  const used = new Set(settings.categories.map((category) => category.tag));
  let tag = RECONCILIATION_CATEGORY;
  let suffix = 2;
  while (used.has(tag)) tag = `${RECONCILIATION_CATEGORY} (${suffix++})`;
  return tag;
}

const OPENING_KEY = 'banking.cashOpeningBalance';
export function cashOpeningBalance(): number {
  try {
    const amount = Number(localStorage.getItem(OPENING_KEY) ?? '0');
    return Number.isFinite(amount) ? amount : 0;
  } catch { return 0; }
}
export function saveCashOpeningBalance(value: number): void {
  localStorage.setItem(OPENING_KEY, String(value));
}

export function cashEntryTx(entry: CashEntry, reconciliationCategory = RECONCILIATION_CATEGORY): Tx {
  const credit = entry.kind === 'income' ? entry.amount : entry.kind === 'adjustment' && entry.amount > 0 ? entry.amount : 0;
  const debit = entry.kind === 'expense' ? entry.amount : entry.kind === 'adjustment' && entry.amount < 0 ? -entry.amount : 0;
  return {
    id: `cash:${entry.id}`, cashEntryId: entry.id,
    manualCategory: entry.kind === 'adjustment' ? reconciliationCategory : entry.category,
    cashAdjustment: entry.kind === 'adjustment',
    file: 'Cash', row: 0, bookingDate: entry.date, valueDate: entry.date, ref: '',
    account: 'Cash', accountAlias: 'Cash', iban: '', ibanDisplay: '',
    text: entry.note || (entry.kind === 'expense' ? 'Cash expense' : entry.kind === 'income' ? 'Cash income' : 'Cash reconciliation adjustment'),
    hay: entry.note.toLowerCase(), credit, debit,
  };
}

/** Chronological order shared by the running-balance calculations and table. */
export function compareTransactionOrder(a: Tx, b: Tx): number {
  return (a.bookingDate || a.valueDate).localeCompare(b.bookingDate || b.valueDate)
    || Number(Boolean(a.cashAdjustment)) - Number(Boolean(b.cashAdjustment))
    || a.ref.localeCompare(b.ref)
    || a.id.localeCompare(b.id);
}

export function movementOf(tx: Tx, settings: Settings): { type: 'withdrawal' | 'deposit'; category: Category } | null {
  // One-off reporting corrections must not invent/remove wallet movements.
  // Cash transfer designation continues to come from the category rules.
  const category = settings.categories.find((c) => c.tag === matchTx({ ...tx, categoryOverrides: undefined }, settings));
  return category?.cashMovement ? { type: category.cashMovement, category } : null;
}

/** Cash-only bank transfers are account movements, not household spending. */
export function isCashTransfer(tx: Tx, settings: Settings): boolean {
  return !tx.cashEntryId && movementOf(tx, settings) !== null;
}

/**
 * A cash-transfer bank row the Spending report should show but not count:
 * its category is a cash movement the user has not opted to include.
 * `counted` holds the cash-movement tags the user clicked "include" for.
 */
export function isUncountedCashTransfer(tx: Tx, settings: Settings, counted: Set<string>): boolean {
  const movement = tx.cashEntryId ? null : movementOf(tx, settings);
  return movement !== null && !counted.has(movement.category.tag);
}

/** Cash includes manual entries and imported rows that move money into/out of the wallet. */
export function matchesTransactionSource(tx: Tx, source: 'cash' | 'bank' | 'both', settings: Settings): boolean {
  if (source === 'both') return true;
  if (source === 'bank') return !tx.cashEntryId;
  return Boolean(tx.cashEntryId) || isCashTransfer(tx, settings);
}

/** Wallet balance immediately after each cash entry or bank cash transfer. */
export function calculateCashBalances(
  txs: Tx[],
  entries: CashEntry[],
  settings: Settings,
  openingBalance: number,
): Map<string, number> {
  const rows: Array<{ key: string; tx: Tx; delta: number }> = [];
  for (const tx of txs) {
    if (!movementOf(tx, settings)) continue;
    rows.push({ key: tx.id, tx, delta: tx.debit - tx.credit });
  }
  for (const entry of entries) {
    const tx = cashEntryTx(entry);
    rows.push({
      key: tx.id, tx,
      delta: entry.kind === 'expense' ? -entry.amount : entry.amount,
    });
  }
  rows.sort((a, b) => compareTransactionOrder(a.tx, b.tx));
  let balance = openingBalance;
  const balances = new Map<string, number>();
  for (const row of rows) {
    balance += row.delta;
    balances.set(row.key, balance);
  }
  return balances;
}

export function allTransactionRows(txs: Tx[], entries: CashEntry[]): Tx[] {
  return [...txs, ...entries.map((entry) => cashEntryTx(entry))].sort((a, b) =>
    (b.bookingDate || '').localeCompare(a.bookingDate || '') || a.id.localeCompare(b.id));
}
