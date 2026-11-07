import type { TreeNode } from './categories/engine';
import type { Tx } from './types';
import type { BalanceSpacing } from './balanceHistory';
import { groupSpendingPeriods } from './spendingHistory';

export type CategoryMeasure = 'expense' | 'income' | 'net';
export type CategoryUnit = 'CHF' | '%';
export interface TrendCategory {
  tag: string;
  label: string;
  color: string;
  dash: string;
  descendants: string[];
}
export interface CategoryPeriod {
  from: string;
  date: string;
  excluded: boolean;
  values: Map<string, number>;
  denominator: number;
}

// Imported CHF values have cent precision; cancellation dust is not activity.
const financialZero = (value: number): number => Math.abs(value) < 1e-8 ? 0 : value;

/** Full paths disambiguate nested categories; the catalog is not capped at the
 * Share chart's top 12, and includes zero-valued and deeply nested categories. */
export function trendCategories(roots: TreeNode[]): TrendCategory[] {
  const result: TrendCategory[] = [];
  const walk = (node: TreeNode, parents: string[]): string[] => {
    const color = node.category?.color ?? '#9aa2ad';
    const item: TrendCategory = {
      tag: node.tag, label: [...parents, node.tag].join(' › '),
      color: parents.length ? `color-mix(in srgb, ${color} 80%, var(--foreground))` : color,
      dash: ['', '6 3', '2 3', '8 3 2 3'][result.length % 4], descendants: [node.tag],
    };
    result.push(item);
    for (const child of node.children) item.descendants.push(...walk(child, [...parents, node.tag]));
    return item.descendants;
  };
  roots.forEach((root) => walk(root, []));
  return result;
}

/** Roll up direct report assignments once per bucket, including all roots in
 * the percentage denominator. Selecting more lines never changes their shares. */
export function buildCategoryPeriods(
  txByTag: Map<string, Tx[]>, roots: TreeNode[], hiddenCats: string[], visibleMonths: string[], hiddenMonths: string[],
  measure: CategoryMeasure, spacing: BalanceSpacing, from: string, to: string,
): CategoryPeriod[] {
  const points: CategoryPeriod[] = groupSpendingPeriods([], spacing, from, to, hiddenMonths)
    .map((point) => ({ from: point.from, date: point.date, excluded: point.excluded, values: new Map(), denominator: 0 }));
  if (!points.length) return points;
  const hidden = new Set(hiddenCats), months = new Set(visibleMonths), excludedMonths = new Set(hiddenMonths);
  for (const [tag, txs] of txByTag) {
    if (hidden.has(tag)) continue;
    for (const tx of txs) {
      const date = tx.bookingDate || tx.valueDate;
      if (!date || date < from || date > to || !months.has(date.slice(0, 7)) || excludedMonths.has(date.slice(0, 7))) continue;
      let lo = 0, hi = points.length - 1;
      while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (points[mid].date < date) lo = mid + 1; else hi = mid; }
      const point = points[lo];
      if (point.excluded) continue;
      const value = measure === 'expense' ? tx.debit : measure === 'income' ? tx.credit : tx.credit - tx.debit;
      point.values.set(tag, (point.values.get(tag) ?? 0) + value);
    }
  }
  const roll = (node: TreeNode, values: Map<string, number>): number => {
    let total = values.get(node.tag) ?? 0;
    for (const child of node.children) total += roll(child, values);
    total = financialZero(total);
    values.set(node.tag, total);
    return total;
  };
  for (const point of points) for (const root of roots) point.denominator += Math.abs(roll(root, point.values));
  return points;
}

/** Same magnitude-share definition as Share, including Net. A zero denominator
 * is unavailable, not 0%; child shares may exceed 100% when parent nets cancel. */
export function categoryTrendValue(point: CategoryPeriod, tag: string, unit: CategoryUnit): number | null {
  if (point.excluded) return null;
  const value = point.values.get(tag) ?? 0;
  return unit === 'CHF' ? value : point.denominator > 0 ? Math.abs(value) / point.denominator * 100 : null;
}

/** Recompute the range denominator from range-level root nets, rather than
 * averaging percentages or summing per-period Net magnitudes. */
export function categoryRangeTotals(points: CategoryPeriod[], rootTags: string[]): CategoryPeriod {
  const values = new Map<string, number>();
  for (const point of points) if (!point.excluded) for (const [tag, value] of point.values) values.set(tag, (values.get(tag) ?? 0) + value);
  for (const [tag, value] of values) values.set(tag, financialZero(value));
  return {
    from: points[0]?.from ?? '', date: points.at(-1)?.date ?? '', excluded: points.every((p) => p.excluded), values,
    denominator: rootTags.reduce((sum, tag) => sum + Math.abs(values.get(tag) ?? 0), 0),
  };
}
