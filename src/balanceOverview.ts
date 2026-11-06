import type { CashEntry, Settings, Tx } from './types';
import {
  bankAccountKey,
  calculatedAccountEndings,
  calculateAccountBalances,
  groupBankAccounts,
  loadAccountOpeningBalances,
  type AccountOpeningBalance,
} from './bankBalances';
import { cashEntryTx, calculateCashBalances, compareTransactionOrder, movementOf } from './cash';

export interface BalanceOverview {
  bankBalance: number;
  bankAccounts: number;
  unanchoredAccounts: string[];
  cashBalance: number;
  corrections: number;
  combinedBalance: number;
}

/** Build the unfiltered current-balance overview used by Spending. */
export function buildBalanceOverview(txs: Tx[], entries: CashEntry[], settings: Settings, cashOpening: number): BalanceOverview {
  const accounts = groupBankAccounts(txs);
  const openings = loadAccountOpeningBalances();
  const endings = calculatedAccountEndings(accounts, openings);
  let bankBalance = 0;
  const unanchoredAccounts: string[] = [];
  for (const account of accounts) {
    const ending = endings.get(account.key);
    const opening = openings[account.key];
    // Without an anchor the per-account ending is net movement from zero. Keep
    // it in the overview as a labelled estimate instead of hiding the total.
    if (ending !== undefined) bankBalance += ending.amount;
    else if (opening) bankBalance += opening.amount;
    if (!opening) unanchoredAccounts.push(account.label);
  }
  // an opening balance set for an account without any imported rows is still
  // money on hand — the Transactions 'All' column counts it, so count it here too
  const loadedKeys = new Set(accounts.map((account) => account.key));
  for (const [key, opening] of Object.entries(openings)) {
    if (!loadedKeys.has(key)) bankBalance += opening.amount;
  }

  const cashRows: Array<{ date: string; delta: number; adjustment: boolean; id: string }> = [];
  for (const tx of txs) {
    const movement = movementOf(tx, settings);
    if (!movement) continue;
    // Bank-side debit increases wallet cash; bank-side credit (cash deposit)
    // decreases it. This same sign convention works for both transfer kinds.
    cashRows.push({ date: tx.bookingDate || tx.valueDate, delta: tx.debit - tx.credit, adjustment: false, id: tx.id });
  }
  let corrections = 0;
  for (const entry of entries) {
    const delta = entry.kind === 'expense' ? -entry.amount : entry.amount;
    const adjustment = entry.kind === 'adjustment';
    if (adjustment) corrections += delta;
    cashRows.push({ date: entry.date, delta, adjustment, id: entry.id });
  }
  cashRows.sort((a, b) => a.date.localeCompare(b.date) || Number(a.adjustment) - Number(b.adjustment) || a.id.localeCompare(b.id));
  const cashBalance = cashOpening + cashRows.reduce((sum, row) => sum + row.delta, 0);
  return {
    bankBalance,
    bankAccounts: accounts.length,
    unanchoredAccounts,
    cashBalance,
    corrections,
    combinedBalance: bankBalance + cashBalance,
  };
}

/**
 * Combined cash + bank running balance after every dated row — bank rows keyed
 * by tx.id, manual cash entries by their 'cash:…' id. A bank row whose category
 * is a cash movement changes wallet and account in opposite directions, so the
 * combined total stays put: money moved, not spent. Accounts without an opening
 * balance contribute net movement from zero (the same Δ caveat the per-account
 * column shows); an opening set for an account without loaded rows still counts.
 */
export function calculateCombinedBalances(
  txs: Tx[],
  entries: CashEntry[],
  settings: Settings,
  cashOpening: number,
  accountOpenings: Record<string, AccountOpeningBalance>,
): Map<string, number> {
  const rowBalances = calculateAccountBalances(txs, accountOpenings);
  const cashBalances = calculateCashBalances(txs, entries, settings, cashOpening);
  // The wallet sweep uses this same ordering, so same-day cash entries and bank
  // transfers cannot pick up balances calculated in the opposite sequence.
  // start each account at the balance immediately before its earliest dated row
  // (derived backwards from the opening by calculateAccountBalances)
  const accountBalances = new Map<string, number>();
  for (const account of groupBankAccounts(txs)) {
    const ordered = [...account.txs].sort(compareTransactionOrder);
    const earliest = ordered.find((tx) => tx.bookingDate || tx.valueDate);
    const after = earliest ? rowBalances.get(earliest.id) : undefined;
    accountBalances.set(account.key,
      after === undefined || !earliest ? accountOpenings[account.key]?.amount ?? 0 : after - (earliest.credit - earliest.debit));
  }
  for (const [key, opening] of Object.entries(accountOpenings)) {
    if (!accountBalances.has(key)) accountBalances.set(key, opening.amount);
  }
  const result = new Map<string, number>();
  let wallet = cashOpening;
  for (const row of [...txs, ...entries.map((entry) => cashEntryTx(entry))].sort(compareTransactionOrder)) {
    if (!row.bookingDate && !row.valueDate) continue; // undated rows have no place in time
    if (!row.cashEntryId) {
      const balance = rowBalances.get(row.id);
      if (balance !== undefined) accountBalances.set(bankAccountKey(row), balance);
    }
    const cashAfter = cashBalances.get(row.id); // set for manual entries and bank cash transfers
    if (cashAfter !== undefined) wallet = cashAfter;
    let total = wallet;
    for (const balance of accountBalances.values()) total += balance;
    result.set(row.id, total);
  }
  return result;
}
