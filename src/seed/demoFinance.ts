import type { FinanceData } from '../finance/model';
import type { Settings, Tx } from '../types';
import { minor } from '../finance/model';
import { detectRecurring } from '../finance/recurring';
import { transferCandidates } from '../finance/transfers';
import { DEMO_FILE_NAME } from './demoCsv';

/** Explicit opt-in demo decisions; never touch a non-demo transaction or overwrite an edit. */
export function addDemoFinance(data: FinanceData, input: Tx[], settings: Settings): void {
  const rows = input.filter((r) => r.file === DEMO_FILE_NAME);
  if (!rows.length) throw new Error('Load the sample statement first.');
  if (data.series.some((s) => s.id.startsWith('demo:') && s.txIds.some((id) => rows.some((r) => r.id === id)))) {
    throw new Error('Planning examples are already present. Review them in the sections below.');
  }
  const bundle = data.bundles[settings.name] ??= { annotations: {}, budgets: [] };
  const tags = new Set(settings.categories.map((c) => c.tag));
  const food = tags.has('Groceries') ? 'Groceries' : settings.categories[0]?.tag;
  const other = tags.has('Shopping') ? 'Shopping' : settings.categories[1]?.tag;
  if (!food || !other) throw new Error('The demo examples need at least two categories.');
  const correction = rows.find((r) => /EXAMPLESELLER99/i.test(r.text));
  if (correction && !bundle.annotations[correction.id]) bundle.annotations[correction.id] = { category: other };
  const purchase = rows.find((r) => r.debit > 1 && /debit card/i.test(r.text) && r.id !== correction?.id && !bundle.annotations[r.id]);
  if (purchase) {
    const total = minor(purchase.debit), half = Math.floor(total / 2);
    bundle.annotations[purchase.id] = { parts: [{ amount: half / 100, category: food, note: 'Demo: groceries' }, { amount: (total - half) / 100, category: other, note: 'Demo: household items' }] };
  }
  if (!bundle.budgets.some((b) => b.category === food)) bundle.budgets.push({ category: food, limit: 250, months: {} });
  const transfer = transferCandidates(rows, data, settings)[0];
  if (transfer) data.transfers.push({ id: transfer.id, left: transfer.left.id, right: transfer.right.id });
  const series = detectRecurring(rows).find((s) => /sunrise/i.test(s.name));
  if (series && !data.series.some((s) => s.keys.some((k) => series.keys.includes(k)) || s.txIds.some((id) => series.rows.some((r) => r.id === id)))) {
    data.series.push({ id: `demo:${series.id}`, name: 'Demo internet subscription', cadence: series.cadence, variable: false, status: 'confirmed', keys: [], txIds: series.rows.map((r) => r.id) });
  }
}
