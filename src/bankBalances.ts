import type { Tx } from './types';

export interface AccountOpeningBalance {
  /** Balance immediately before transactions booked on this date. */
  date: string;
  amount: number;
}

export interface BankAccountRows {
  key: string;
  label: string;
  txs: Tx[];
}

const KEY = 'banking.accountOpeningBalances';

function accountIdentity(tx: Tx): { key: string; label: string } {
  if (tx.iban) {
    const last4 = tx.iban.slice(-4);
    return { key: `iban:${tx.iban}`, label: tx.accountAlias || `Account ···· ${last4}` };
  }
  const account = tx.account.trim();
  if (account) return { key: `account:${account.toLowerCase()}`, label: tx.accountAlias || account };
  const alias = tx.accountAlias.trim();
  if (alias) return { key: `alias:${alias.toLowerCase()}`, label: alias };
  return { key: 'account:unknown', label: 'Unidentified account' };
}

export function bankAccountKey(tx: Tx): string {
  return accountIdentity(tx).key;
}

export function groupBankAccounts(txs: Tx[]): BankAccountRows[] {
  const groups = new Map<string, BankAccountRows>();
  for (const tx of txs) {
    const { key, label } = accountIdentity(tx);
    const group = groups.get(key) ?? { key, label, txs: [] };
    if (!group.txs.length && label) group.label = label;
    group.txs.push(tx);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function loadAccountOpeningBalances(): Record<string, AccountOpeningBalance> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    const valid: Record<string, AccountOpeningBalance> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!value || typeof value !== 'object') continue;
      const row = value as Record<string, unknown>;
      if (typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date)
        && typeof row.amount === 'number' && Number.isFinite(row.amount)) {
        valid[key] = { date: row.date, amount: row.amount };
      }
    }
    return valid;
  } catch { return {}; }
}

export function saveAccountOpeningBalance(accountKey: string, value: AccountOpeningBalance): void {
  const values = loadAccountOpeningBalances();
  values[accountKey] = value;
  localStorage.setItem(KEY, JSON.stringify(values));
}

export function removeAccountOpeningBalance(accountKey: string): void {
  const values = loadAccountOpeningBalances();
  delete values[accountKey];
  localStorage.setItem(KEY, JSON.stringify(values));
}

/** Running balances after each bank transaction; balances are also derived backwards from a later anchor date. */
export function calculateAccountBalances(
  txs: Tx[],
  openings: Record<string, AccountOpeningBalance>,
): Map<string, number | undefined> {
  const balances = new Map<string, number | undefined>();
  for (const account of groupBankAccounts(txs)) {
    const opening = openings[account.key];
    const ordered = [...account.txs].sort((a, b) =>
      (a.bookingDate || a.valueDate).localeCompare(b.bookingDate || b.valueDate)
      || a.ref.localeCompare(b.ref) || a.id.localeCompare(b.id));
    if (!opening) {
      // Without an opening balance, still show the cumulative movement from
      // zero at the earliest dated imported transaction. This is informative,
      // but not the actual bank balance until an opening balance is supplied.
      let movement = 0;
      for (const tx of ordered) {
        const date = tx.bookingDate || tx.valueDate;
        if (!date) { balances.set(tx.id, undefined); continue; }
        movement += tx.credit - tx.debit;
        balances.set(tx.id, movement);
      }
      continue;
    }
    const anchor = ordered.findIndex((tx) => (tx.bookingDate || tx.valueDate) >= opening.date);
    const forwardStart = anchor < 0 ? ordered.length : anchor;
    let balance = opening.amount;
    for (let i = forwardStart; i < ordered.length; i++) {
      const tx = ordered[i];
      const date = tx.bookingDate || tx.valueDate;
      if (!date) { balances.set(tx.id, undefined); continue; }
      balance += tx.credit - tx.debit;
      balances.set(tx.id, balance);
    }
    // The configured amount is the balance immediately before transactions on
    // the opening date. Subtract earlier movements in reverse to derive their
    // balances too, so a checkpoint near the end of a partial export is useful.
    balance = opening.amount;
    for (let i = forwardStart - 1; i >= 0; i--) {
      const tx = ordered[i];
      const date = tx.bookingDate || tx.valueDate;
      if (!date) { balances.set(tx.id, undefined); continue; }
      balances.set(tx.id, balance);
      balance -= tx.credit - tx.debit;
    }
  }
  return balances;
}

export function calculatedAccountEndings(
  accounts: BankAccountRows[],
  openings: Record<string, AccountOpeningBalance>,
): Map<string, { amount: number; date: string } | undefined> {
  const allTxs = accounts.flatMap((account) => account.txs);
  const rowBalances = calculateAccountBalances(allTxs, openings);
  const result = new Map<string, { amount: number; date: string } | undefined>();
  for (const account of accounts) {
    const ordered = [...account.txs].sort((a, b) =>
      (a.bookingDate || a.valueDate).localeCompare(b.bookingDate || b.valueDate)
      || a.ref.localeCompare(b.ref) || a.id.localeCompare(b.id));
    const latest = ordered.at(-1);
    const value = latest ? rowBalances.get(latest.id) : undefined;
    const date = latest?.bookingDate || latest?.valueDate || '';
    result.set(account.key, value === undefined || !latest ? undefined : { amount: value, date });
  }
  return result;
}
