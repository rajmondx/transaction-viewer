import type { Settings, Tx } from '../types';
import type { FinanceData, SplitPart } from './model';
import { minor } from './model';
import { bankAccountKey } from '../bankBalances';
import { isCashTransfer } from '../cash';

export function validSplit(tx: Tx, parts: SplitPart[]): boolean {
  return !tx.cashAdjustment && !tx.internalTransfer && (tx.credit > 0) !== (tx.debit > 0)
    && parts.length >= 2 && parts.every((p) => Number.isFinite(p.amount) && minor(p.amount) > 0 && Number.isSafeInteger(minor(p.amount)))
    && parts.reduce((sum, p) => sum + minor(p.amount), 0) === minor(tx.credit + tx.debit);
}

export function validTransfer(a: Tx, b: Tx): boolean {
  const ak = bankAccountKey(a), bk = bankAccountKey(b);
  return a.id !== b.id && !a.cashEntryId && !b.cashEntryId && ak !== bk
    && ak !== 'account:unknown' && bk !== 'account:unknown'
    && !a.cashAdjustment && !b.cashAdjustment
    && ((a.debit > 0 && a.credit === 0 && b.credit > 0 && b.debit === 0 && minor(a.debit) === minor(b.credit))
      || (b.debit > 0 && b.credit === 0 && a.credit > 0 && a.debit === 0 && minor(b.debit) === minor(a.credit)));
}

/** Refresh only derived metadata; bank values and raw data remain unchanged. */
export function annotateRows(rows: Tx[], data: FinanceData, settings: Settings): Tx[] {
  const byId = new Map(rows.map((t) => [t.id, t]));
  const linked = new Set<string>();
  for (const link of data.transfers) {
    const a = byId.get(link.left), b = byId.get(link.right);
    const hasSplit = (id: string) => Object.values(data.bundles).some((v) => v.annotations[id]?.parts?.length);
    if (a && b && validTransfer(a, b) && !hasSplit(a.id) && !hasSplit(b.id)) {
      // Cash classification must use current overrides, not stale row metadata.
      const decorate = (t: Tx): Tx => ({ ...t, categoryOverrides: Object.fromEntries(Object.entries(data.bundles)
        .flatMap(([name, v]) => v.annotations[t.id]?.category ? [[name, v.annotations[t.id].category!]] : [])) });
      if (!isCashTransfer(decorate(a), settings) && !isCashTransfer(decorate(b), settings)) { linked.add(a.id); linked.add(b.id); }
    }
  }
  return rows.map((t) => ({ ...t, internalTransfer: linked.has(t.id), categoryOverrides: Object.fromEntries(
    Object.entries(data.bundles).flatMap(([name, v]) => v.annotations[t.id]?.category ? [[name, v.annotations[t.id].category!]] : [])),
  }));
}

export function allocationRows(rows: Tx[], data: FinanceData, settings: Settings): Tx[] {
  return annotateRows(rows, data, settings).flatMap((tx) => {
    if (tx.internalTransfer) return [];
    const parts = data.bundles[settings.name]?.annotations[tx.id]?.parts;
    if (!parts || !validSplit(tx, parts) || isCashTransfer(tx, settings)) return [tx];
    return parts.map((p, i) => ({ ...tx, id: `${tx.id}:part:${i}`, parentId: tx.id,
      debit: tx.debit ? minor(p.amount) / 100 : 0, credit: tx.credit ? minor(p.amount) / 100 : 0,
      manualCategory: p.category, categoryOverrides: undefined, text: p.note ? `${tx.text} — ${p.note}` : tx.text,
    }));
  });
}
