import type { Settings, Tx } from '../types';
import type { FinanceData } from './model';
import { minor } from './model';
import { isCashTransfer } from '../cash';
import { validTransfer } from './reporting';

export const pairId = (a: string, b: string): string => JSON.stringify([a, b].sort());
export interface TransferCandidate { id: string; left: Tx; right: Tx; days: number; reason: string }

export function transferCandidates(rows: Tx[], data: FinanceData, settings: Settings, windowDays = 4): TransferCandidate[] {
  const linked = new Set(data.transfers.flatMap((t) => [t.left, t.right]));
  const rejected = new Set(data.rejectedTransfers);
  const credits = new Map<number, Tx[]>();
  const eligible = rows.filter((t) => !linked.has(t.id) && !t.cashEntryId && !isCashTransfer(t, settings)
    && !Object.values(data.bundles).some((b) => b.annotations[t.id]?.parts));
  for (const tx of eligible) if (tx.credit > 0 && !tx.debit) {
    const key = minor(tx.credit);
    const group = credits.get(key) ?? []; group.push(tx); credits.set(key, group);
  }
  for (const group of credits.values()) group.sort((a, b) => a.bookingDate.localeCompare(b.bookingDate));
  const results: TransferCandidate[] = [];
  for (const debit of eligible) {
    if (!debit.debit || debit.credit) continue;
    const group = credits.get(minor(debit.debit)) ?? [];
    const time = Date.parse(debit.bookingDate);
    if (!Number.isFinite(time)) continue;
    const lower = time - windowDays * 86400000, upper = time + windowDays * 86400000;
    let lo = 0, hi = group.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (Date.parse(group[mid].bookingDate) < lower) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < group.length; i++) {
      const credit = group[i], date = Date.parse(credit.bookingDate);
      if (date > upper) break;
      const days = Math.abs(date - time) / 86400000;
      const id = pairId(debit.id, credit.id);
      if (!Number.isFinite(days) || rejected.has(id) || !validTransfer(debit, credit)) continue;
      results.push({ id, left: debit, right: credit, days, reason: `Equal opposite amounts · distinct accounts · ${days} day(s) apart${debit.ref && debit.ref === credit.ref ? ' · same reference' : ''}` });
    }
  }
  return results.sort((a, b) => a.days - b.days || a.id.localeCompare(b.id));
}
