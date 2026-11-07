import type { CashEntry, Settings, Tx } from './types';
import type { AccountOpeningBalance } from './bankBalances';
import { calculateCombinedBalances } from './balanceOverview';
import { calculateCashBalances, cashEntryTx, compareTransactionOrder } from './cash';

export type BalanceSeries = 'total' | 'cash' | 'bank';
export type BalanceSpacing = 'Daily' | 'Weekly' | 'Monthly' | 'Quarterly' | 'Yearly';
export interface BalancePoint { date: string; total: number; cash: number; bank: number }

/** Dated closing balances, using exactly the running-balance rules of Transactions.
 * Undated rows cannot be placed on a timeline; the UI explicitly calls this out. */
export function buildBalanceHistory(
  txs: Tx[], entries: CashEntry[], settings: Settings, cashOpening: number,
  openings: Record<string, AccountOpeningBalance>,
): BalancePoint[] {
  const combined = calculateCombinedBalances(txs, entries, settings, cashOpening, openings);
  const cash = calculateCashBalances(txs, entries, settings, cashOpening);
  const rows = [...txs, ...entries.map((entry) => cashEntryTx(entry))].sort(compareTransactionOrder);
  const points: BalancePoint[] = [];
  let wallet = cashOpening;
  for (const row of rows) {
    const date = row.bookingDate || row.valueDate;
    if (!date) continue;
    wallet = cash.get(row.id) ?? wallet;
    const total = combined.get(row.id)!;
    const point = { date, total, cash: wallet, bank: total - wallet };
    if (points.at(-1)?.date === date) points[points.length - 1] = point;
    else points.push(point);
  }
  return points;
}

const iso = (date: Date): string => date.toISOString().slice(0, 10);
const utc = (date: string): Date => new Date(`${date}T00:00:00Z`);

export function periodEnd(date: string, spacing: BalanceSpacing): string {
  const d = utc(date);
  if (spacing === 'Weekly') d.setUTCDate(d.getUTCDate() + (7 - d.getUTCDay()) % 7); // Monday–Sunday
  if (spacing === 'Monthly') d.setUTCMonth(d.getUTCMonth() + 1, 0);
  if (spacing === 'Quarterly') d.setUTCMonth(Math.floor(d.getUTCMonth() / 3) * 3 + 3, 0);
  if (spacing === 'Yearly') d.setUTCFullYear(d.getUTCFullYear() + 1, 0, 0);
  return iso(d);
}

/** Sample period-end balances, never sums. Empty periods carry forward the last
 * known balance, and the final partial period ends on the selected end date. */
export function sampleBalanceHistory(
  history: BalancePoint[], spacing: BalanceSpacing, from: string, to: string,
): BalancePoint[] {
  if (!history.length || from > to || to < history[0].date) return [];
  const start = from < history[0].date ? history[0].date : from;
  const result: BalancePoint[] = [];
  let index = 0;
  let cursor = start;
  while (cursor <= to) {
    const end = periodEnd(cursor, spacing);
    const date = end < to ? end : to;
    while (index + 1 < history.length && history[index + 1].date <= date) index++;
    result.push({ ...history[index], date });
    const next = utc(date);
    next.setUTCDate(next.getUTCDate() + 1);
    cursor = iso(next);
  }
  return result;
}

/** Shared stock-chart range presets, clamped to the available history. */
export function balanceRangeStart(end: string, months: number, earliest: string): string {
  const d = utc(end);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return iso(d) < earliest ? earliest : iso(d);
}
