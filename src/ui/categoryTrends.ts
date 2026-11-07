import { X } from 'lucide';
import type { TreeNode } from '../categories/engine';
import type { Tx } from '../types';
import { balanceRangeStart, type BalanceSpacing } from '../balanceHistory';
import { buildCategoryPeriods, trendCategories, type CategoryMeasure, type CategoryPeriod, type CategoryUnit } from '../categoryHistory';
import { shareBars, type ShareItem } from './charts';
import { categoryLines } from './categoryLines';
import { Ic } from './icons';
import { C, clear, cx, dmy, h, togBtn } from './util';

// Session-local choices survive report re-renders and the Sub-categories toggle.
const selected = new Set<string>();
let spacing: BalanceSpacing = 'Monthly';
let unit: CategoryUnit = 'CHF';
let range: '1M' | '3M' | '1Y' | 'All' | 'Custom' = 'All';
let customFrom = '', customTo = '';

interface CategoryScope {
  items: ShareItem[];
  measure: CategoryMeasure;
  measureName: string;
  total: number;
  denominator: number;
  roots: TreeNode[];
  txByTag: Map<string, Tx[]>;
  scopeRows: Tx[];
  hiddenCats: string[];
  visibleMonths: string[];
  hiddenMonths: string[];
  dateFrom: string;
  dateTo: string;
}

export function categoryTrends(scope: CategoryScope): HTMLElement {
  const root = h('div');
  const catalog = trendCategories(scope.roots);
  for (const tag of selected) if (!catalog.some((category) => category.tag === tag)) selected.delete(tag);
  let earliest = '', latest = '';
  for (const row of scope.scopeRows) {
    const date = row.bookingDate || row.valueDate;
    if (!date) continue;
    if (!earliest || date < earliest) earliest = date;
    if (!latest || date > latest) latest = date;
  }
  if (earliest) { earliest = scope.dateFrom || earliest; latest = scope.dateTo || latest; }
  let dispose: (() => void) | undefined;
  let cachedKey = '', cached: CategoryPeriod[] = [];
  function toggle(tag: string): void {
    const removingLegend = (document.activeElement as HTMLElement | null)?.dataset?.fk === `category-remove-${encodeURIComponent(tag)}`;
    if (selected.has(tag)) selected.delete(tag); else selected.add(tag);
    render();
    if (removingLegend) root.querySelector<HTMLElement>('[data-fk="category-picker"]')?.focus();
  }
  function render(): void {
    const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.fk;
    dispose?.(); clear(root);
    root.appendChild(shareBars(scope.items, scope.measureName, {
      total: scope.total, denominator: scope.denominator, selected, onCategoryClick: toggle,
    }));
    const picker = h('select', { class: cx(C.input, 'min-w-0 max-w-full'), dataset: { fk: 'category-picker' }, attrs: { 'aria-label': 'Add category to trends' } },
      h('option', { text: 'Add category…', attrs: { value: '' } }),
      ...catalog.filter((category) => !selected.has(category.tag)).map((category) => h('option', {
        text: category.label + (scope.hiddenCats.includes(category.tag) ? ' (own assignments filtered)' : ''), attrs: { value: category.tag },
      }))) as HTMLSelectElement;
    picker.onchange = () => { if (picker.value) { selected.add(picker.value); render(); } };
    root.appendChild(h('div', { class: 'mt-3 flex min-w-0 flex-wrap items-center gap-2' },
      picker, h('span', { class: 'text-[11px] text-muted-foreground', text: 'Click categories or sub-categories to compare their trends.' })));
    const panel = h('section', { class: 'mt-3 min-w-0 bg-subtle p-3', attrs: { id: 'category-trends-panel', 'aria-label': 'Category trends' } });
    panel.hidden = selected.size === 0;
    root.appendChild(panel);
    if (!selected.size) { restoreFocus(); return; }
    panel.appendChild(h('div', { class: 'mb-3 flex flex-wrap items-center justify-between gap-2' },
      h('h3', { class: 'text-sm font-semibold', text: `Category trends · ${scope.measureName} · ${unit}` }),
      h('button', { class: C.btn, dataset: { fk: 'category-clear' }, attrs: { type: 'button' }, onclick: () => {
        selected.clear(); render(); root.querySelector<HTMLElement>('[data-fk="category-picker"]')?.focus();
      } }, Ic(X, 'size-3.5'), 'Clear selection')));
    const chosen = catalog.filter((category) => selected.has(category.tag));
    panel.appendChild(h('div', { class: 'mb-3 flex flex-wrap gap-2' }, ...chosen.map((category) => h('button', {
      class: cx(C.btn, 'max-w-full text-xs'), dataset: { fk: `category-remove-${encodeURIComponent(category.tag)}` },
      attrs: { type: 'button', 'aria-label': `Remove ${category.label} from category trends` }, onclick: () => toggle(category.tag),
    }, h('span', { class: 'inline-block w-4 shrink-0', style: { borderTop: `2px ${category.dash ? 'dashed' : 'solid'} ${category.color}` } }),
    h('span', { class: 'min-w-0 break-words text-left', text: category.label }), Ic(X, 'size-3')))));
    if (!earliest || !latest || earliest > latest) {
      panel.appendChild(h('p', { class: 'text-sm text-muted-foreground', text: 'No dated transactions in the current Spending filters.' }));
      restoreFocus(); return;
    }
    const from = range === 'Custom' ? customFrom || earliest : range === 'All' ? earliest
      : balanceRangeStart(latest, range === '1M' ? 1 : range === '3M' ? 3 : 12, earliest);
    const to = range === 'Custom' ? customTo || latest : latest;
    const spacingButtons = (['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Yearly'] as const).map((value) => togBtn(`category-spacing-${value}`, value, `${value} category totals`, spacing === value, () => { spacing = value; render(); }));
    const unitButtons = (['CHF', '%'] as const).map((value) => togBtn(`category-unit-${value}`, value, value === 'CHF' ? 'Signed amounts in CHF' : 'Magnitude share of all filtered top-level categories', unit === value, () => { unit = value; render(); }));
    const rangeButtons = (['1M', '3M', '1Y', 'All'] as const).map((value) => togBtn(`category-range-${value}`, value, `Show ${value === 'All' ? 'all filtered history' : `the last ${value} within the report`}`, range === value, () => { range = value; render(); }));
    const fromInput = h('input', { class: cx(C.input, 'min-w-0 max-w-full'), dataset: { fk: 'category-from' }, attrs: { type: 'date', value: from, min: earliest, max: latest, 'aria-label': 'Category trends from' } }) as HTMLInputElement;
    const toInput = h('input', { class: cx(C.input, 'min-w-0 max-w-full'), dataset: { fk: 'category-to' }, attrs: { type: 'date', value: to, min: earliest, max: latest, 'aria-label': 'Category trends to' } }) as HTMLInputElement;
    const applyDates = () => { customFrom = fromInput.value || earliest; customTo = toInput.value || latest; range = 'Custom'; render(); };
    fromInput.onchange = applyDates; toInput.onchange = applyDates;
    const control = (caption: string, ...children: HTMLElement[]) => h('div', {}, h('div', { class: cx(C.label, 'mb-1'), text: caption }), h('div', { class: 'flex flex-wrap gap-1' }, ...children));
    panel.appendChild(h('div', { class: 'mb-3 flex flex-wrap gap-x-6 gap-y-3' }, control('Point spacing', ...spacingButtons), control('Unit', ...unitButtons), control('Date range', ...rangeButtons),
      h('div', { class: 'flex min-w-0 flex-wrap items-end gap-2' },
        h('label', { class: 'flex min-w-0 flex-col gap-1' }, h('span', { class: C.label, text: 'From' }), fromInput),
        h('label', { class: 'flex min-w-0 flex-col gap-1' }, h('span', { class: C.label, text: 'To' }), toInput))));
    if (from > to || from < earliest || to > latest || from > latest || to < earliest) {
      panel.appendChild(h('p', { class: 'text-sm text-muted-foreground', attrs: { role: 'status' }, text: from > to ? 'Choose a From date on or before the To date.'
        : `Choose dates within the filtered report: ${dmy(earliest)} – ${dmy(latest)}.` }));
    } else {
      const key = `${spacing}:${from}:${to}`;
      if (cachedKey !== key) {
        cached = buildCategoryPeriods(scope.txByTag, scope.roots, scope.hiddenCats, scope.visibleMonths, scope.hiddenMonths, scope.measure, spacing, from, to);
        cachedKey = key;
      }
      const chart = categoryLines(cached, chosen, unit, scope.roots.map((node) => node.tag));
      panel.appendChild(chart.element); dispose = chart.dispose;
      if (cached.every((point) => point.excluded)) panel.appendChild(h('p', { class: 'mt-2 text-xs text-muted-foreground', text: 'All periods in this range are hidden by month filters.' }));
    }
    panel.appendChild(h('p', { class: 'mt-2 text-[11px] text-muted-foreground', text: 'Period totals · Weeks end Sunday · Uses Spending filters. Parents include their descendants; parent and child lines overlap and must not be added together. Hidden months are gaps. Hover, tap or use arrow keys; Escape restores range totals.' }));
    if (unit === '%') panel.appendChild(h('p', { class: 'mt-1 text-[11px] text-muted-foreground', text: 'Share % = absolute category value ÷ sum of absolute top-level values for that period, across all filtered categories (not just selected lines or the top 12). Zero totals are unavailable. In Net, percentages show magnitude; CHF preserves direction. Child shares can exceed 100% when parent nets cancel.' }));
    if (chosen.length > 6) panel.appendChild(h('p', { class: 'mt-1 text-xs text-warning', text: 'Many lines are selected. Remove some categories for an easier comparison.' }));
    if ([...scope.txByTag].some(([tag, rows]) => !scope.hiddenCats.includes(tag) && rows.some((row) => !row.bookingDate && !row.valueDate)))
      panel.appendChild(h('p', { class: 'mt-1 text-xs text-warning', text: 'Undated transactions cannot be plotted; chart totals may differ from Share.' }));
    restoreFocus();
    function restoreFocus(): void {
      if (focusKey) root.querySelector<HTMLElement>(`[data-fk="${focusKey}"]`)?.focus();
    }
  }
  render();
  return root;
}
