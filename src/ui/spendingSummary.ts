import { ArrowLeftRight, ChevronDown, ReceiptText, Tags, TrendingDown, TrendingUp, X } from 'lucide';
import { balanceRangeStart, type BalanceSpacing } from '../balanceHistory';
import { buildSpendingDays, groupSpendingPeriods, spendingCoverage, type SpendingDay, type SpendingTotals } from '../spendingHistory';
import type { Tx } from '../types';
import { C, clear, cx, dmy, h, money, num0, togBtn } from './util';
import { Ic } from './icons';
import { SPENDING_METRICS, spendingTimeline, type SpendingMetric } from './spendingTimeline';

const selected = new Set<SpendingMetric>();
let spacing: BalanceSpacing = 'Monthly';
let range: '1M' | '3M' | '1Y' | 'All' | 'Custom' = 'All';
let customFrom = '', customTo = '';
const ICONS = { income: TrendingUp, expenses: TrendingDown, net: ArrowLeftRight, transactions: ReceiptText, categorized: Tags };

interface SummaryScope {
  totals: SpendingTotals;
  txByTag: Map<string, Tx[]>;
  scopeRows: Tx[];
  hiddenCats: string[];
  hiddenMonths: string[];
  visibleMonths: string[];
  reconciliationCategory: string;
  dateFrom: string;
  dateTo: string;
}

/** Footer cards retain report-wide values. Their shared panel can further narrow
 * the date range, but can never expand past the report's current scope. */
export function spendingSummary(scope: SummaryScope): HTMLElement {
  const root = h('section', { class: 'mt-4', attrs: { 'aria-label': 'Spending summary' } });
  const cards = h('div', { class: 'grid gap-2.5 grid-cols-[repeat(auto-fit,minmax(140px,1fr))]' });
  const panel = h('div', { attrs: { id: 'spending-history-panel' } });
  const coverage = spendingCoverage(scope.totals);
  const buttons = SPENDING_METRICS.map((metric) => {
    const value = metric.key === 'categorized' ? coverage === null ? 'No expenses' : `${coverage.toFixed(1)} %`
      : metric.key === 'transactions' ? num0(scope.totals.transactions) : money(scope.totals[metric.key]);
    const tone = metric.key === 'income' ? 'text-success' : metric.key === 'expenses' ? 'text-danger'
      : metric.key === 'net' ? scope.totals.net < 0 ? 'text-danger' : 'text-success' : '';
    const button = h('button', {
      dataset: { fk: `spending-summary-${metric.key}` }, attrs: { type: 'button', 'aria-controls': 'spending-history-panel' },
      title: `Show or hide ${metric.label.toLowerCase()} in the summary timeline`, onclick: () => toggle(metric.key),
    }, h('span', { class: cx(C.label, 'flex items-center gap-1.5') }, Ic(ICONS[metric.key], 'size-3.5'), metric.label, Ic(ChevronDown, 'ml-auto size-3.5')),
    h('span', { class: cx('mt-0.5 block text-[19px] font-bold', tone), text: value }));
    cards.appendChild(button);
    return button;
  });
  root.appendChild(cards); root.appendChild(panel);
  let days: SpendingDay[] | undefined;
  let dispose: (() => void) | undefined;
  // Keep bounds independent of hidden categories/months so deselecting a month
  // leaves a visible gap instead of silently stretching its neighbours together.
  let earliest = '', latest = '';
  for (const row of scope.scopeRows) {
    const date = row.bookingDate || row.valueDate;
    if (!date) continue;
    if (!earliest || date < earliest) earliest = date;
    if (!latest || date > latest) latest = date;
  }
  if (earliest) { earliest = scope.dateFrom || earliest; latest = scope.dateTo || latest; }

  function toggle(metric: SpendingMetric): void {
    if (selected.has(metric)) selected.delete(metric); else selected.add(metric);
    render();
  }
  function render(): void {
    const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.fk;
    dispose?.(); clear(panel);
    buttons.forEach((button, i) => {
      const active = selected.has(SPENDING_METRICS[i].key);
      button.className = cx(C.card, 'balance-card cursor-pointer px-3.5 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-primary', active && 'balance-card-active');
      button.style.setProperty('--balance-color', SPENDING_METRICS[i].color);
      button.setAttribute('aria-pressed', String(active)); button.setAttribute('aria-expanded', String(active));
    });
    panel.hidden = selected.size === 0;
    if (!selected.size) return;
    const box = h('section', { class: cx(C.card, 'mt-2 min-w-0 p-3.5'), attrs: { 'aria-label': 'Spending summary history' } });
    box.appendChild(h('div', { class: 'mb-3 flex items-center justify-between gap-2' }, h('h3', { class: 'text-sm font-semibold', text: 'Spending summary history' }),
      h('button', { class: C.btn, attrs: { type: 'button', 'aria-label': 'Close spending summary chart' }, onclick: () => {
        selected.clear(); render(); buttons[0].focus();
      } }, Ic(X, 'size-3.5'))));
    panel.appendChild(box);
    if (!earliest || !latest || earliest > latest) {
      box.appendChild(h('p', { class: 'text-sm text-muted-foreground', text: 'No dated transactions in the current Spending filters.' }));
      return;
    }
    const from = range === 'Custom' ? customFrom || earliest : range === 'All' ? earliest
      : balanceRangeStart(latest, range === '1M' ? 1 : range === '3M' ? 3 : 12, earliest);
    const to = range === 'Custom' ? customTo || latest : latest;
    const spacingButtons = (['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Yearly'] as const).map((value) => togBtn(`summary-spacing-${value}`, value, `${value} totals`, spacing === value, () => { spacing = value; render(); }));
    const rangeButtons = (['1M', '3M', '1Y', 'All'] as const).map((value) => togBtn(`summary-range-${value}`, value, `Show ${value === 'All' ? 'all filtered history' : `the last ${value} within the report`}`, range === value, () => { range = value; render(); }));
    const fromInput = h('input', { class: cx(C.input, 'min-w-0 max-w-full'), dataset: { fk: 'summary-from' }, attrs: { type: 'date', value: from, min: earliest, max: latest, 'aria-label': 'Spending summary chart from' } }) as HTMLInputElement;
    const toInput = h('input', { class: cx(C.input, 'min-w-0 max-w-full'), dataset: { fk: 'summary-to' }, attrs: { type: 'date', value: to, min: earliest, max: latest, 'aria-label': 'Spending summary chart to' } }) as HTMLInputElement;
    const applyDates = () => { customFrom = fromInput.value || earliest; customTo = toInput.value || latest; range = 'Custom'; render(); };
    fromInput.onchange = applyDates; toInput.onchange = applyDates;
    box.appendChild(h('div', { class: 'mb-3 flex flex-wrap gap-x-6 gap-y-3' },
      h('div', {}, h('div', { class: cx(C.label, 'mb-1'), text: 'Point spacing' }), h('div', { class: 'flex flex-wrap gap-1' }, ...spacingButtons)),
      h('div', {}, h('div', { class: cx(C.label, 'mb-1'), text: 'Date range' }), h('div', { class: 'flex flex-wrap gap-1' }, ...rangeButtons)),
      h('div', { class: 'flex min-w-0 flex-wrap items-end gap-2' },
        h('label', { class: 'flex min-w-0 flex-col gap-1' }, h('span', { class: C.label, text: 'From' }), fromInput),
        h('label', { class: 'flex min-w-0 flex-col gap-1' }, h('span', { class: C.label, text: 'To' }), toInput))));
    box.appendChild(h('div', { class: 'mb-2 flex flex-wrap gap-2' }, ...SPENDING_METRICS.map((metric) => h('button', {
      class: cx(C.btn, 'text-xs', selected.has(metric.key) ? 'balance-legend-active' : 'opacity-50'),
      dataset: { fk: `summary-legend-${metric.key}` }, attrs: { type: 'button', 'aria-pressed': String(selected.has(metric.key)) }, onclick: () => toggle(metric.key),
    }, h('span', { class: 'inline-block w-4', style: { borderTop: `2px ${metric.dash ? 'dashed' : 'solid'} ${metric.color}` } }), metric.label))));
    if (from > to || from < earliest || to > latest || from > latest || to < earliest) {
      box.appendChild(h('p', { class: 'text-sm text-muted-foreground', attrs: { role: 'status' }, text: from > to
        ? 'Choose a From date on or before the To date.' : `Choose dates within the filtered report: ${dmy(earliest)} – ${dmy(latest)}.` }));
    } else {
      days ??= buildSpendingDays(scope.txByTag, scope.hiddenCats, scope.visibleMonths, scope.reconciliationCategory);
      const points = groupSpendingPeriods(days, spacing, from, to, scope.hiddenMonths);
      const chart = spendingTimeline(points, selected);
      box.appendChild(chart.element); dispose = chart.dispose;
      if (points.every((p) => p.excluded)) box.appendChild(h('p', { class: 'mt-2 text-xs text-muted-foreground', text: 'All periods in this range are hidden by month filters.' }));
    }
    box.appendChild(h('p', { class: 'mt-2 text-[11px] text-muted-foreground', text: 'Period totals, not cumulative balances · Weeks end Sunday · Only selected months/categories contribute. Hover, tap or use arrow keys to inspect all lanes; leave the chart or press Escape for range totals.' }));
    if (selected.has('categorized')) box.appendChild(h('p', { class: 'mt-1 text-[11px] text-muted-foreground', text: 'Coverage strip: green = categorized expense value; amber = uncategorized (including reconciliation corrections); grey = no expenses or hidden month. Income does not affect coverage.' }));
    if ([...scope.txByTag].some(([tag, rows]) => !scope.hiddenCats.includes(tag) && rows.some((row) => !row.bookingDate && !row.valueDate)))
      box.appendChild(h('p', { class: 'mt-1 text-xs text-warning', text: 'Undated transactions cannot be plotted; chart totals may differ from the summary cards.' }));
    if (focusKey) root.querySelector<HTMLElement>(`[data-fk="${focusKey}"]`)?.focus();
  }
  render();
  return root;
}
