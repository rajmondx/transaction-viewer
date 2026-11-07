import { describe, expect, it } from 'vitest';
import type { Settings, Tx } from '../src/types';
import { emptyFinance, parseFinance, renameFinanceCategories } from '../src/finance/model';
import { allocationRows, annotateRows, validSplit, validTransfer } from '../src/finance/reporting';
import { transferCandidates, pairId } from '../src/finance/transfers';
import { detectRecurring, nextDate, recurringKey } from '../src/finance/recurring';
import { budgetActuals } from '../src/finance/budgets';
import { aggregate, matchTx } from '../src/categories/engine';
import { BACKUP_FORMAT, parseBackup } from '../src/storage/backup';
import { buildSpendingDays } from '../src/spendingHistory';
import { demoCsv, DEMO_FILE_NAME } from '../src/seed/demoCsv';
import { addDemoFinance } from '../src/seed/demoFinance';
import { parseWithMapper } from '../src/csv/parse';
import { ABS_MAPPER } from '../src/csv/schemas';
import { seedSettings } from '../src/categories/schema';
import { calculateAccountBalances } from '../src/bankBalances';
import { calculateCashBalances } from '../src/cash';

const settings: Settings = { name: 'default', categories: ['Housing', 'Rent', 'Food', 'Other'].map((tag) => ({
  tag, tagFather: tag === 'Rent' ? 'Housing' : null, color: '#fff', ibans: [], enabled: true,
  rules: [{ text: tag.toLowerCase(), caseSensitive: false, fuzzy: false, regex: false }], dateFrom: null, dateTo: null,
})) };
function tx(id: string, date = '2026-01-01', amount = -100, text = 'Food', account = 'A'): Tx {
  return { id, bookingDate: date, valueDate: date, text, hay: text, credit: Math.max(0, amount), debit: Math.max(0, -amount),
    account, accountAlias: account, iban: '', ibanDisplay: '', ref: '', file: 'sample.csv', row: 1 };
}
const seriesRows = (dates: string[], amounts: number[] = [], text = 'Stream TV'): Tx[] => dates.map((date, i) => tx(`s${i}`, date, -(amounts[i] ?? 10), text));

describe('annotations and allocation reporting', () => {
  it('scopes one-off overrides to bundles and supports reset without changing imported data', () => {
    const data = emptyFinance(), original = tx('a');
    data.bundles.default = { annotations: { a: { category: 'Rent' } }, budgets: [] };
    const rows = annotateRows([original], data, settings);
    expect(matchTx(rows[0], settings)).toBe('Rent');
    expect(matchTx(rows[0], { ...settings, name: 'other' })).toBe('Food');
    expect(original.categoryOverrides).toBeUndefined();
    expect(rows[0].debit).toBe(original.debit);
    delete data.bundles.default.annotations.a.category;
    expect(matchTx(annotateRows(rows, data, settings)[0], settings)).toBe('Food');
  });

  it('uses Uncategorized for a missing category instead of silently following another rule', () => {
    expect(matchTx({ ...tx('a'), categoryOverrides: { default: 'Deleted' } }, settings)).toBe('Uncategorized');
  });

  it('replaces parent amounts with exact parts and counts unique parents', () => {
    const data = emptyFinance(), original = tx('a', '2026-01-01', -0.3);
    const parts = [{ amount: 0.1, category: 'Food', note: 'first' }, { amount: 0.2, category: 'Rent', note: '' }];
    expect(validSplit(original, parts)).toBe(true);
    data.bundles.default = { annotations: { a: { parts } }, budgets: [] };
    const allocations = allocationRows([original], data, settings), result = aggregate(allocations, settings);
    expect(allocations).toHaveLength(2);
    expect(allocations.every((t) => t.parentId === 'a')).toBe(true);
    expect(result.totals.debit).toBeCloseTo(0.3);
    expect(result.totals.count).toBe(1);
    expect(original.debit).toBe(0.3);
    expect(validSplit(original, [...parts, { amount: 0.01, category: 'Food', note: '' }])).toBe(false);
  });

  it('counts a parent once when multiple allocations use the same category', () => {
    const data = emptyFinance();
    data.bundles.default = { annotations: { a: { parts: [{ amount: 40, category: 'Food', note: '' }, { amount: 60, category: 'Food', note: '' }] } }, budgets: [] };
    const result = aggregate(allocationRows([tx('a')], data, settings), settings);
    expect(result.own.get('Food')?.get('2026-01')?.count).toBe(1);
  });

  it('retains invalid splits but does not apply them after an amount change', () => {
    const data = emptyFinance();
    data.bundles.default = { annotations: { a: { parts: [{ amount: 40, category: 'Food', note: '' }, { amount: 60, category: 'Rent', note: '' }] } }, budgets: [] };
    const rows = allocationRows([tx('a', '2026-01-01', -120)], data, settings);
    expect(rows).toHaveLength(1); expect(rows[0].debit).toBe(120);
    expect(data.bundles.default.annotations.a.parts).toHaveLength(2);
  });
  it('carries corrections, split categories and budgets through explicit renames', () => {
    const data = emptyFinance();
    data.bundles.default = { annotations: { a: { category: 'Food', parts: [{ amount: 1, category: 'Food', note: '' }, { amount: 2, category: 'Rent', note: '' }] } }, budgets: [{ category: 'Food', limit: 100, months: { '2026-01': 0 } }] };
    renameFinanceCategories(data, 'default', [['Food', 'Dining'], ['Dining', 'Meals']]);
    expect(data.bundles.default.annotations.a.category).toBe('Meals');
    expect(data.bundles.default.annotations.a.parts?.[0].category).toBe('Meals');
    expect(data.bundles.default.budgets[0]).toEqual({ category: 'Meals', limit: 100, months: { '2026-01': 0 } });
  });
  it('uses unique parent counts in summary history across categories', () => {
    const data = emptyFinance(); data.bundles.default = { annotations: { a: { parts: [{ amount: 40, category: 'Food', note: '' }, { amount: 60, category: 'Rent', note: '' }] } }, budgets: [] };
    const agg = aggregate(allocationRows([tx('a')], data, settings), settings);
    expect(buildSpendingDays(agg.txByTag, [], ['2026-01'], 'Reconciliations')[0].transactions).toBe(1);
  });
  it('does not let a category-only correction remove a wallet transfer', () => {
    const cashSettings: Settings = { ...settings, categories: [...settings.categories, { ...settings.categories[0], tag: 'ATM', rules: [{ text: 'ATM', caseSensitive: false, fuzzy: false, regex: false }], cashMovement: 'withdrawal' }] };
    const original = tx('atm', '2026-01-01', -100, 'ATM');
    const data = emptyFinance(); data.bundles.default = { annotations: { atm: { category: 'Food' } }, budgets: [] };
    const annotated = annotateRows([original], data, cashSettings);
    expect(calculateCashBalances(annotated, [], cashSettings, 0)).toEqual(calculateCashBalances([original], [], cashSettings, 0));
    expect(calculateAccountBalances(annotated, {})).toEqual(calculateAccountBalances([original], {}));
  });
});

describe('internal transfers', () => {
  const debit = tx('out', '2026-01-01', -100, 'Transfer', 'A');
  const credit = tx('in', '2026-01-03', 100, 'Transfer', 'B');
  it('suggests, never confirms, distinct-account pairs and respects dismissals', () => {
    const data = emptyFinance();
    expect(transferCandidates([debit, credit], data, settings)).toHaveLength(1);
    expect(allocationRows([debit, credit], data, settings)).toHaveLength(2);
    data.rejectedTransfers = [pairId(debit.id, credit.id)];
    expect(transferCandidates([debit, credit], data, settings)).toHaveLength(0);
  });
  it('rejects same account, unknown identity, unequal amounts and self pairing', () => {
    expect(validTransfer(debit, { ...credit, account: 'A' })).toBe(false);
    expect(validTransfer(debit, { ...credit, account: '', accountAlias: '' })).toBe(false);
    expect(validTransfer(debit, { ...credit, credit: 99 })).toBe(false);
    expect(validTransfer(debit, debit)).toBe(false);
  });
  it('excludes both confirmed legs but makes missing-leg exclusions inactive', () => {
    const data = emptyFinance(); data.transfers = [{ id: 'pair', left: 'out', right: 'in' }];
    expect(allocationRows([debit, credit], data, settings)).toEqual([]);
    expect(allocationRows([debit], data, settings)).toHaveLength(1);
    expect(data.transfers).toHaveLength(1);
    expect(allocationRows([credit, debit], data, settings)).toEqual([]);
    expect(debit.debit).toBe(100); expect(credit.credit).toBe(100);
  });
  it('does not apply links when a split exists in any bundle', () => {
    const data = emptyFinance(); data.transfers = [{ id: 'pair', left: 'out', right: 'in' }];
    data.bundles.other = { annotations: { out: { parts: [{ amount: 40, category: 'Food', note: '' }, { amount: 60, category: 'Rent', note: '' }] } }, budgets: [] };
    expect(allocationRows([debit, credit], data, settings)).toHaveLength(2);
  });
  it('keeps multiple plausible pairs for explicit review', () => {
    expect(transferCandidates([debit, credit, { ...credit, id: 'another' }], emptyFinance(), settings)).toHaveLength(2);
  });
});

describe('recurring-payment detection', () => {
  it('detects month-end schedules with booking variation and a price increase', () => {
    const rows = seriesRows(['2026-01-30', '2026-02-27', '2026-03-31', '2026-04-30'], [10, 10, 10, 12]);
    const [series] = detectRecurring(rows);
    expect(series.cadence).toBe('monthly'); expect(series.status).toBe('candidate');
    expect(series.variable).toBe(false); expect(series.change).toBe(2); expect(series.monthly).toBe(12);
    expect(series.next).toBe('2026-05-31');
  });
  it.each([
    ['weekly', ['2026-01-01', '2026-01-08', '2026-01-15'], 52 / 12],
    ['fortnightly', ['2026-01-01', '2026-01-15', '2026-01-29'], 26 / 12],
    ['quarterly', ['2026-01-01', '2026-04-01', '2026-07-01'], 1 / 3],
    ['annual', ['2024-02-29', '2025-02-28', '2026-02-28'], 1 / 12],
  ] as const)('detects %s schedules and normalizes monthly cost', (cadence, dates, factor) => {
    const [s] = detectRecurring(seriesRows([...dates]));
    expect(s.cadence).toBe(cadence); expect(s.monthly).toBeCloseTo(10 * factor);
  });
  it('marks variable utilities and suppresses subscription-price alerts', () => {
    const [s] = detectRecurring(seriesRows(['2026-01-10', '2026-02-10', '2026-03-10', '2026-04-10'], [80, 125, 90, 150], 'Utility'));
    expect(s.variable).toBe(true); expect(s.change).toBeNull(); expect(s.usual).toBe(107.5);
  });
  it('does not classify sparse monthly or frequent irregular shopping', () => {
    expect(detectRecurring(seriesRows(['2026-01-01', '2026-02-01']))).toEqual([]);
    expect(detectRecurring(seriesRows(['2026-01-01', '2026-01-03', '2026-01-20', '2026-02-01'], [], 'Supermarket'))).toEqual([]);
  });
  it('labels two annual observations low confidence', () => {
    expect(detectRecurring(seriesRows(['2025-01-01', '2026-01-01']))[0].confidence).toBe('low');
  });
  it('deduplicates IDs and excludes transfers and reconciliations', () => {
    const rows = seriesRows(['2026-01-01', '2026-02-01', '2026-03-01']);
    expect(detectRecurring([...rows, ...rows])[0].rows).toHaveLength(3);
    expect(detectRecurring(rows.map((r) => ({ ...r, internalTransfer: true })))).toEqual([]);
    expect(detectRecurring(rows.map((r) => ({ ...r, cashAdjustment: true })))).toEqual([]);
  });
  it('normalizes reference digits but keeps unrelated merchants/accounts separate', () => {
    const rows = seriesRows(['2026-01-01', '2026-02-01', '2026-03-01']).map((r, i) => ({ ...r, text: `Stream TV invoice ${100 + i}` }));
    expect(detectRecurring(rows)).toHaveLength(1);
    expect(recurringKey(rows[0])).not.toBe(recurringKey({ ...rows[0], account: 'B' }));
    expect(recurringKey(rows[0])).not.toBe(recurringKey({ ...rows[0], text: 'Different TV' }));
  });
  it('persists dismissed/confirmed ownership and stops ended series extending', () => {
    const rows = seriesRows(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01']);
    const decision = { id: 'saved', name: 'My bill', txIds: rows.slice(0, 3).map((r) => r.id), keys: [recurringKey(rows[0])], status: 'dismissed' as const, cadence: 'monthly' as const, variable: false };
    const dismissed = detectRecurring(rows, [decision]);
    expect(dismissed).toHaveLength(1); expect(dismissed[0].status).toBe('dismissed'); expect(dismissed[0].rows).toHaveLength(4);
    expect(detectRecurring(rows, [{ ...decision, status: 'ended' }])[0].rows).toHaveLength(3);
    expect(detectRecurring(rows, [{ ...decision, status: 'confirmed' }, { ...decision, id: 'overlap', status: 'confirmed' }])).toHaveLength(1);
  });
  it('handles leap-day and calendar clamping', () => {
    expect(nextDate('2024-02-29', 'annual')).toBe('2025-02-28');
    expect(nextDate('2026-01-31', 'monthly')).toBe('2026-02-28');
  });
});

describe('budgets and backups', () => {
  it('rolls split expenses into ancestors but ignores credits, transfers and adjustments', () => {
    const data = emptyFinance();
    data.bundles.default = { annotations: { a: { parts: [{ amount: 40, category: 'Food', note: '' }, { amount: 60, category: 'Rent', note: '' }] } }, budgets: [] };
    const result = budgetActuals([tx('a'), tx('refund', '2026-01-02', 20, 'Food'), { ...tx('adjust'), cashAdjustment: true }, tx('feb', '2026-02-01')], data, settings, '2026-01');
    expect(result.get('Food')).toBe(40); expect(result.get('Rent')).toBe(60); expect(result.get('Housing')).toBe(60);
  });
  it('round-trips every new decision and migrates old backups to empty decisions', () => {
    const data = emptyFinance();
    data.bundles.default = { annotations: { a: { category: 'Food' } }, budgets: [{ category: 'Food', limit: 100, months: { '2026-01': 0 } }] };
    data.series = [{ id: 's', name: 'Bill', txIds: ['a'], keys: [], status: 'confirmed', cadence: 'monthly', variable: false }];
    const backup = { format: BACKUP_FORMAT, schemaVersion: 3, exportedAt: '', data: { localStorage: {}, csvFiles: [], cashEntries: [], finance: data } };
    expect(parseBackup(JSON.parse(JSON.stringify(backup))).data.finance).toEqual(data);
    expect(parseBackup({ ...backup, schemaVersion: 2 }).data.finance).toEqual(emptyFinance());
    expect(() => parseBackup({ ...backup, data: { ...backup.data, finance: undefined } })).toThrow(/finance/);
  });
  it('rejects malformed new records before restore writes', () => {
    expect(() => parseFinance({ ...emptyFinance(), transfers: [{ id: 'x', left: 'a', right: 'a' }] })).toThrow();
    expect(() => parseFinance({ ...emptyFinance(), series: [{ name: 'bad' }] })).toThrow();
    expect(() => parseFinance({ ...emptyFinance(), bundles: { default: { annotations: {}, budgets: [{ category: 'Food', limit: -1, months: {} }] } } })).toThrow();
  });
  it('provides explicit, synthetic demo examples without editing real data', () => {
    const demo = parseWithMapper(demoCsv(new Date(2026, 10, 7)), DEMO_FILE_NAME, ABS_MAPPER).txs;
    const data = emptyFinance(), categories = seedSettings();
    addDemoFinance(data, [...demo, tx('real')], categories);
    expect(data.bundles.default.annotations.real).toBeUndefined();
    expect(Object.values(data.bundles.default.annotations).some((a) => a.parts?.length === 2)).toBe(true);
    expect(data.transfers).toHaveLength(1); expect(data.bundles.default.budgets).toHaveLength(1);
    const [series] = detectRecurring(demo, data.series);
    expect(series.status).toBe('confirmed'); expect(series.change).toBe(10);
    expect(() => addDemoFinance(data, demo, categories)).toThrow(/already present/);
  });
});
