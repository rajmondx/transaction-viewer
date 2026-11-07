import { describe, expect, it } from 'vitest';
import { buildTree } from '../src/categories/engine';
import { parseSettings } from '../src/categories/schema';
import { buildCategoryPeriods, categoryRangeTotals, categoryTrendValue, trendCategories, type CategoryMeasure } from '../src/categoryHistory';
import type { Tx } from '../src/types';

const roots = buildTree(parseSettings(JSON.stringify({ categories: [
  { tag: 'Housing', color: '#5577aa' }, { tag: 'Rent', tag_father: 'Housing', color: '#5577aa' },
  { tag: 'Utilities', tag_father: 'Rent', color: '#5577aa' }, { tag: 'Food' }, { tag: 'Salary' }, { tag: 'Unused' },
] }), 'test'));
function tx(id: string, date: string, amount: number): Tx {
  return { id, bookingDate: date, valueDate: '', file: 'test.csv', row: 1, ref: '', account: 'Main',
    accountAlias: '', iban: '', ibanDisplay: '', text: '', hay: '', credit: Math.max(0, amount), debit: Math.max(0, -amount) };
}
const assigned = new Map([
  ['Housing', [tx('own', '2026-01-01', -20)]], ['Rent', [tx('rent', '2026-01-02', -80)]],
  ['Utilities', [tx('utilities', '2026-01-03', -20)]], ['Food', [tx('food', '2026-01-04', -80)]],
  ['Salary', [tx('salary', '2026-01-01', 1000)]],
]);
const periods = (measure: CategoryMeasure = 'expense', hiddenCats: string[] = []) => buildCategoryPeriods(
  assigned, roots, hiddenCats, ['2026-01'], [], measure, 'Monthly', '2026-01-01', '2026-01-31',
);

describe('Category trend catalog and rollups', () => {
  it('includes all depths, paths, zero-value categories and Uncategorized', () => {
    const catalog = trendCategories(roots);
    expect(catalog.find((c) => c.tag === 'Housing')?.descendants).toEqual(['Housing', 'Rent', 'Utilities']);
    expect(catalog.find((c) => c.tag === 'Utilities')?.label).toBe('Housing › Rent › Utilities');
    expect(catalog.find((c) => c.tag === 'Unused')).toBeDefined();
    expect(catalog.find((c) => c.tag === 'Uncategorized')).toBeDefined();
    expect(catalog.find((c) => c.tag === 'Rent')?.color).toContain('color-mix');
  });
  it('rolls up descendants without counting parents twice in the denominator', () => {
    const point = periods()[0];
    expect(point.values.get('Housing')).toBe(120);
    expect(point.values.get('Rent')).toBe(100);
    expect(point.values.get('Utilities')).toBe(20);
    expect(point.denominator).toBe(200);
    expect(categoryTrendValue(point, 'Housing', '%')).toBe(60);
    expect(categoryTrendValue(point, 'Rent', '%')).toBe(50);
    expect(categoryTrendValue(point, 'Unused', 'CHF')).toBe(0);
  });
  it('hides only a parent’s own assignments, keeping its visible descendants', () => {
    const point = periods('expense', ['Housing'])[0];
    expect(point.values.get('Housing')).toBe(100);
    expect(point.denominator).toBe(180);
    const childHidden = periods('expense', ['Rent'])[0];
    expect(childHidden.values.get('Housing')).toBe(40); // own 20 + visible Utilities 20
    expect(childHidden.values.get('Rent')).toBe(20);
  });
  it('supports Income and signed Net CHF with magnitude percentages', () => {
    expect(periods('income')[0].denominator).toBe(1000);
    expect(categoryTrendValue(periods('income')[0], 'Salary', '%')).toBe(100);
    const net = periods('net')[0];
    expect(net.denominator).toBe(1200);
    expect(categoryTrendValue(net, 'Housing', 'CHF')).toBe(-120);
    expect(categoryTrendValue(net, 'Housing', '%')).toBe(10);
  });
});

describe('Category trend periods and shares', () => {
  const days = new Map([['Food', [tx('jan', '2024-01-31', -30), tx('feb', '2024-02-29', -20), tx('apr', '2024-04-02', -50)]]]);
  it('uses all five calendar spacings with exact boundaries and partial end periods', () => {
    for (const spacing of ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Yearly'] as const) {
      const points = buildCategoryPeriods(days, roots, [], ['2024-01', '2024-02', '2024-04'], [], 'expense', spacing, '2024-02-01', '2024-04-02');
      expect(points[0].from).toBe('2024-02-01');
      expect(points.at(-1)?.date).toBe('2024-04-02');
      expect(categoryRangeTotals(points, roots.map((root) => root.tag)).values.get('Food')).toBe(70);
    }
    const weekly = buildCategoryPeriods(days, roots, [], ['2024-02'], [], 'expense', 'Weekly', '2024-02-28', '2024-03-05');
    expect(weekly.map((p) => p.date)).toEqual(['2024-03-03', '2024-03-05']);
  });
  it('keeps hidden months as gaps but inactive months as zero CHF and unavailable shares', () => {
    const points = buildCategoryPeriods(days, roots, [], ['2024-01', '2024-02', '2024-04'], ['2024-02'], 'expense', 'Monthly', '2024-01-01', '2024-04-02');
    expect(categoryTrendValue(points[1], 'Food', 'CHF')).toBeNull();
    expect(categoryTrendValue(points[2], 'Food', 'CHF')).toBe(0);
    expect(categoryTrendValue(points[2], 'Food', '%')).toBeNull();
    const yearly = buildCategoryPeriods(days, roots, [], ['2024-01', '2024-02', '2024-04'], ['2024-02'], 'expense', 'Yearly', '2024-01-01', '2024-04-02');
    expect(yearly[0].values.get('Food')).toBe(80); // hidden Feb must not leak into a mixed bucket
  });
  it('handles cancellations without dividing by signed net or clamping child shares', () => {
    const rows = new Map([['Rent', [tx('out', '2026-01-01', -100)]], ['Utilities', [tx('in', '2026-01-02', 100)]], ['Food', [tx('other', '2026-01-02', -50)]]]);
    const point = buildCategoryPeriods(rows, roots, [], ['2026-01'], [], 'net', 'Monthly', '2026-01-01', '2026-01-31')[0];
    expect(point.denominator).toBe(50); // Housing and Rent cancel to zero; Food remains
    expect(point.values.get('Housing')).toBe(0);
    expect(categoryTrendValue(point, 'Utilities', '%')).toBe(200);
    rows.delete('Food');
    const zero = buildCategoryPeriods(rows, roots, [], ['2026-01'], [], 'net', 'Monthly', '2026-01-01', '2026-01-31')[0];
    expect(categoryTrendValue(zero, 'Utilities', '%')).toBeNull();
  });
  it('recomputes range shares from range-level nets instead of averaging period shares', () => {
    const rows = new Map([['Salary', [tx('a', '2026-01-01', 100), tx('b', '2026-02-01', -100)]], ['Food', [tx('c', '2026-01-01', -50), tx('d', '2026-02-01', -50)]]]);
    const points = buildCategoryPeriods(rows, roots, [], ['2026-01', '2026-02'], [], 'net', 'Monthly', '2026-01-01', '2026-02-28');
    const total = categoryRangeTotals(points, roots.map((r) => r.tag));
    expect(total.denominator).toBe(100);
    expect(categoryTrendValue(total, 'Food', '%')).toBe(100);
    expect(categoryTrendValue(total, 'Salary', '%')).toBe(0);
  });
  it('does not mistake floating-point cancellation dust for a percentage denominator', () => {
    const rows = new Map([['Salary', [tx('a', '2026-01-01', 0.1), tx('b', '2026-01-01', 0.2), tx('c', '2026-01-01', -0.3)]]]);
    const point = buildCategoryPeriods(rows, roots, [], ['2026-01'], [], 'net', 'Monthly', '2026-01-01', '2026-01-31')[0];
    expect(point.denominator).toBe(0);
    expect(categoryTrendValue(point, 'Salary', '%')).toBeNull();
  });
  it('omits undated rows, uses value dates, and handles empty and invalid ranges', () => {
    const rows = new Map([['Food', [tx('undated', '', -500), { ...tx('value', '', -10), valueDate: '2026-01-01' }]]]);
    const point = buildCategoryPeriods(rows, roots, [], ['2026-01'], [], 'expense', 'Monthly', '2026-01-01', '2026-01-31')[0];
    expect(point.values.get('Food')).toBe(10);
    expect(buildCategoryPeriods(rows, roots, [], [], [], 'expense', 'Monthly', '2026-02-01', '2026-01-01')).toEqual([]);
    expect(categoryTrendValue(buildCategoryPeriods(new Map(), roots, [], [], [], 'net', 'Monthly', '2026-01-01', '2026-01-31')[0], 'Food', '%')).toBeNull();
  });
});
