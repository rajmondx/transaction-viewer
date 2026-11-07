import { ArrowLeftRight, Banknote, ChevronDown, X } from 'lucide';
import type { CashEntry, Settings, Tx } from '../types';
import { buildBalanceOverview } from '../balanceOverview';
import { loadAccountOpeningBalances } from '../bankBalances';
import { balanceRangeStart, buildBalanceHistory, sampleBalanceHistory, type BalancePoint, type BalanceSeries, type BalanceSpacing } from '../balanceHistory';
import { C, clear, cx, dmy, h, money, num2, togBtn } from './util';
import { Ic } from './icons';

const SERIES: Array<{ key: BalanceSeries; label: string; color: string; dash: string }> = [
  { key: 'total', label: 'Total balance', color: 'var(--primary)', dash: '' },
  { key: 'cash', label: 'Cash balance', color: 'var(--success)', dash: '3 3' },
  { key: 'bank', label: 'Bank balance', color: 'var(--warning)', dash: '8 3' },
];
const SPACINGS: BalanceSpacing[] = ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Yearly'];
// Like the existing month drill-down, retain choices for this browser session.
const selected = new Set<BalanceSeries>();
let spacing: BalanceSpacing = 'Monthly';
let range: '1M' | '3M' | '1Y' | 'All' | 'Custom' = 'All';
let customFrom = '', customTo = '';

/** Interactive shared chart below the independently selectable balance cards. */
export function balanceSummary(txs: Tx[], entries: CashEntry[], settings: Settings, cashOpening: number): HTMLElement {
  const overview = buildBalanceOverview(txs, entries, settings, cashOpening);
  const estimated = overview.unanchoredAccounts.length > 0;
  const root = h('section', { class: 'mb-3' }, h('h2', { class: 'mb-2 text-sm font-semibold', text: 'Balance summary' }));
  const cards = h('div', { class: 'grid grid-cols-[repeat(auto-fit,minmax(165px,1fr))] gap-2' });
  const panel = h('div', { attrs: { id: 'balance-history-panel' } });
  const values = { total: overview.combinedBalance, cash: overview.cashBalance, bank: overview.bankBalance };
  const buttons = SERIES.map((series) => {
    const button = h('button', {
      dataset: { fk: `balance-${series.key}` },
      attrs: { type: 'button', 'aria-controls': 'balance-history-panel' },
      title: `Show or hide ${series.label.toLowerCase()} history`,
      onclick: () => { toggle(series.key); },
    },
    h('span', { class: cx(C.label, 'flex items-center gap-1.5') },
      Ic(series.key === 'bank' ? ArrowLeftRight : Banknote, 'size-3.5'), series.label,
      Ic(ChevronDown, 'ml-auto size-3.5')),
    h('span', { class: cx('mt-0.5 block text-[19px] font-bold', values[series.key] < 0 && 'text-danger'),
      text: `${estimated && series.key !== 'cash' ? 'Δ ' : ''}${money(values[series.key])}` }));
    cards.appendChild(button);
    return button;
  });
  root.appendChild(cards);
  root.appendChild(h('div', { class: cx(C.card, 'mt-2 px-3.5 py-2.5 text-xs text-muted-foreground') }, estimated
    ? `Δ is an estimate: accounts without opening balances use net movement from zero. Set opening balances in Transactions for actual bank and total balances. Missing anchors: ${overview.unanchoredAccounts.join(', ')}.`
    : 'Opening balances, imported transactions, cash activity and reconciliation corrections are reflected here. Spending filters below affect only the report.'));
  root.appendChild(panel);
  let history: BalancePoint[] | undefined;
  let dispose: (() => void) | undefined;

  function toggle(key: BalanceSeries): void {
    if (selected.has(key)) selected.delete(key); else selected.add(key);
    render();
  }
  function render(): void {
    const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.fk;
    dispose?.();
    clear(panel);
    buttons.forEach((button, i) => {
      const active = selected.has(SERIES[i].key);
      button.className = cx(C.card, 'balance-card cursor-pointer px-3.5 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-primary', active && 'balance-card-active');
      button.style.setProperty('--balance-color', SERIES[i].color);
      button.setAttribute('aria-pressed', String(active));
      button.setAttribute('aria-expanded', String(active));
    });
    panel.hidden = selected.size === 0;
    if (!selected.size) return;
    history ??= buildBalanceHistory(txs, entries, settings, cashOpening, loadAccountOpeningBalances());
    const box = h('section', { class: cx(C.card, 'mt-2 min-w-0 p-3.5'), attrs: { 'aria-label': 'Balance history' } });
    const close = h('button', { class: C.btn, title: 'Close balance chart', attrs: { type: 'button', 'aria-label': 'Close balance chart' }, onclick: () => {
      selected.clear(); render(); buttons[0].focus();
    } }, Ic(X, 'size-3.5'));
    box.appendChild(h('div', { class: 'mb-3 flex items-center justify-between gap-2' },
      h('h3', { class: 'text-sm font-semibold', text: 'Balance history' }), close));
    panel.appendChild(box);
    if (!history.length) {
      box.appendChild(h('p', { class: 'text-sm text-muted-foreground', text: 'No dated transactions to chart yet.' }));
      return;
    }
    const earliest = history[0].date, latest = history.at(-1)!.date;
    const from = range === 'Custom' ? customFrom || earliest : range === 'All' ? earliest
      : balanceRangeStart(latest, range === '1M' ? 1 : range === '3M' ? 3 : 12, earliest);
    const to = range === 'Custom' ? customTo || latest : latest;
    const spacingButtons = SPACINGS.map((value) => togBtn(`balance-spacing-${value}`, value, `${value} closing balances`, spacing === value, () => { spacing = value; render(); }));
    const rangeButtons = (['1M', '3M', '1Y', 'All'] as const).map((value) => togBtn(`balance-range-${value}`, value, `Show ${value === 'All' ? 'all available history' : `the last ${value}`}`, range === value, () => { range = value; render(); }));
    const fromInput = h('input', { class: cx(C.input, 'min-w-0 max-w-full'), dataset: { fk: 'balance-from' }, attrs: { type: 'date', value: from, min: earliest, max: latest, 'aria-label': 'Balance chart from' } }) as HTMLInputElement;
    const toInput = h('input', { class: cx(C.input, 'min-w-0 max-w-full'), dataset: { fk: 'balance-to' }, attrs: { type: 'date', value: to, min: earliest, max: latest, 'aria-label': 'Balance chart to' } }) as HTMLInputElement;
    const applyDates = () => { customFrom = fromInput.value || earliest; customTo = toInput.value || latest; range = 'Custom'; render(); };
    fromInput.onchange = applyDates; toInput.onchange = applyDates;
    box.appendChild(h('div', { class: 'mb-3 flex flex-wrap gap-x-6 gap-y-3' },
      h('div', {}, h('div', { class: cx(C.label, 'mb-1'), text: 'Point spacing' }), h('div', { class: 'flex flex-wrap gap-1' }, ...spacingButtons)),
      h('div', {}, h('div', { class: cx(C.label, 'mb-1'), text: 'Date range' }), h('div', { class: 'flex flex-wrap gap-1' }, ...rangeButtons)),
      h('div', { class: 'flex min-w-0 flex-wrap items-end gap-2' },
        h('label', { class: 'flex min-w-0 flex-col gap-1' }, h('span', { class: C.label, text: 'From' }), fromInput),
        h('label', { class: 'flex min-w-0 flex-col gap-1' }, h('span', { class: C.label, text: 'To' }), toInput))));
    const visible = SERIES.filter((s) => selected.has(s.key));
    box.appendChild(h('div', { class: 'mb-2 flex flex-wrap gap-2' }, ...SERIES.map((s) => h('button', {
      class: cx(C.btn, 'text-xs', selected.has(s.key) ? 'balance-legend-active' : 'opacity-50'), dataset: { fk: `balance-legend-${s.key}` }, attrs: { type: 'button', 'aria-pressed': String(selected.has(s.key)) }, onclick: () => toggle(s.key),
    }, h('span', { class: 'inline-block w-4', style: { borderTop: `2px ${s.dash ? 'dashed' : 'solid'} ${s.color}` } }), s.label))));
    const outsideHistory = from < earliest || from > latest || to < earliest || to > latest;
    const points = outsideHistory ? [] : sampleBalanceHistory(history, spacing, from, to);
    if (!points.length) box.appendChild(h('p', { class: 'text-sm text-muted-foreground', attrs: { role: 'status' }, text: from > to
      ? 'Choose a From date on or before the To date.'
      : outsideHistory ? `Choose dates within available history: ${dmy(earliest)} – ${dmy(latest)}.` : 'No balance history in this date range.' }));
    else {
      const chart = balanceLineChart(points, visible, estimated);
      box.appendChild(chart.element);
      dispose = chart.dispose;
    }
    box.appendChild(h('p', { class: 'mt-2 text-[11px] text-muted-foreground', text: 'Hover, tap or use arrow keys to inspect. Period-end balances · Weeks end Sunday · Empty periods carry forward · Final partial period ends on the selected date. Spending filters do not affect this chart.' }));
    if (txs.some((tx) => !tx.bookingDate && !tx.valueDate)) box.appendChild(h('p', { class: 'mt-1 text-xs text-warning', text: 'Undated transactions cannot be plotted; chart balances may differ from the summary.' }));
    if (focusKey) root.querySelector<HTMLElement>(`[data-fk="${focusKey}"]`)?.focus();
  }
  render();
  return root;
}

/** Responsive SVG without a chart dependency. An inline readout stays on-screen
 * on phones; pointer, touch and arrow keys all select the same dated point. */
function balanceLineChart(points: BalancePoint[], series: typeof SERIES, estimated: boolean): { element: HTMLElement; dispose: () => void } {
  const element = h('div', { class: 'min-w-0' });
  const readout = h('div', { class: 'mb-2 flex min-h-12 flex-wrap items-center gap-x-5 gap-y-1 text-xs tabular-nums', attrs: { 'aria-live': 'polite', 'aria-atomic': 'true' } });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'block w-full outline-none focus-visible:ring-2 focus-visible:ring-primary');
  svg.setAttribute('height', '260');
  svg.setAttribute('tabindex', '0');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Balance history chart. Use Left and Right arrow keys to inspect dates, Home and End for first and last points.');
  svg.style.touchAction = 'pan-y';
  element.appendChild(readout); element.appendChild(svg);
  let width = 600, index = points.length - 1;
  const ns = 'http://www.w3.org/2000/svg';
  function node(tag: string, attrs: Record<string, string | number>, text?: string): SVGElement {
    const el = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
    if (text !== undefined) el.textContent = text;
    svg.appendChild(el);
    return el;
  }
  const firstTime = Date.parse(points[0].date), lastTime = Date.parse(points.at(-1)!.date);
  const x = (p: BalancePoint): number => 76 + (lastTime === firstTime ? 0.5 : (Date.parse(p.date) - firstTime) / (lastTime - firstTime)) * (width - 90);
  let low = Infinity, high = -Infinity;
  for (const p of points) for (const s of series) { low = Math.min(low, p[s.key]); high = Math.max(high, p[s.key]); }
  const margin = Math.max((high - low) * 0.12, Math.abs(high) * 0.01, 1);
  low -= margin; high += margin;
  const y = (v: number): number => 16 + (high - v) / (high - low) * 212;
  let crosshair: SVGElement;
  let markers: SVGElement[] = [];
  function inspect(next: number): void {
    index = next;
    const p = points[index];
    crosshair.setAttribute('x1', String(x(p))); crosshair.setAttribute('x2', String(x(p)));
    markers.forEach((marker, i) => { marker.setAttribute('cx', String(x(p))); marker.setAttribute('cy', String(y(p[series[i].key]))); });
    clear(readout);
    readout.appendChild(h('strong', { text: dmy(p.date) }));
    series.forEach((s) => readout.appendChild(h('span', { style: { color: s.color }, text: `${s.label}: ${estimated && s.key !== 'cash' ? 'Δ ' : ''}${money(p[s.key])}` })));
  }
  function draw(): void {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    svg.setAttribute('viewBox', `0 0 ${width} 260`);
    for (let i = 0; i <= 4; i++) {
      const value = low + (high - low) * i / 4;
      node('line', { x1: 76, x2: width - 14, y1: y(value), y2: y(value), stroke: 'var(--border)' });
      node('text', { x: 68, y: y(value) + 4, 'text-anchor': 'end', fill: 'var(--muted-foreground)', 'font-size': 10 }, Math.abs(value) >= 10000 ? `${num2(value / 1000)}k` : num2(value));
    }
    if (low < 0 && high > 0) node('line', { x1: 76, x2: width - 14, y1: y(0), y2: y(0), stroke: 'var(--muted-foreground)', 'stroke-dasharray': '3 3' });
    for (const s of series) {
      const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p).toFixed(2)},${y(p[s.key]).toFixed(2)}`).join(' ');
      if (series.length === 1 && points.length > 1) node('path', { d: `${path} L${x(points.at(-1)!)},228 L${x(points[0])},228 Z`, fill: `color-mix(in srgb, ${s.color} 10%, transparent)` });
      node('path', { d: path, stroke: s.color, fill: 'none', 'stroke-width': 2, 'stroke-dasharray': s.dash, 'stroke-linejoin': 'round' });
    }
    node('text', { x: 76, y: 250, fill: 'var(--muted-foreground)', 'font-size': 10 }, dmy(points[0].date));
    if (points.length > 1) node('text', { x: width - 14, y: 250, 'text-anchor': 'end', fill: 'var(--muted-foreground)', 'font-size': 10 }, dmy(points.at(-1)!.date));
    crosshair = node('line', { y1: 12, y2: 228, stroke: 'var(--muted-foreground)', 'stroke-dasharray': '3 3' });
    markers = series.map((s) => node('circle', { r: 3.5, fill: s.color, stroke: 'var(--card)', 'stroke-width': 1.5 }));
    inspect(index);
  }
  svg.onpointermove = svg.onpointerdown = (event: PointerEvent) => {
    const rect = svg.getBoundingClientRect();
    const target = firstTime + Math.max(0, Math.min(1, ((event.clientX - rect.left) * width / rect.width - 76) / (width - 90))) * (lastTime - firstTime);
    let lo = 0, hi = points.length - 1;
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (Date.parse(points[mid].date) < target) lo = mid + 1; else hi = mid; }
    if (lo > 0 && target - Date.parse(points[lo - 1].date) < Date.parse(points[lo].date) - target) lo--;
    inspect(lo);
  };
  svg.onkeydown = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    inspect(event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 : Math.max(0, Math.min(points.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1))));
  };
  draw();
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => {
    if (!element.isConnected) { observer?.disconnect(); return; }
    const next = Math.max(240, Math.round(element.getBoundingClientRect().width));
    if (next !== width) { width = next; draw(); }
  });
  observer?.observe(element);
  const start = points[0], end = points.at(-1)!;
  element.appendChild(h('div', { class: 'mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs' }, ...series.map((s) => {
    const change = end[s.key] - start[s.key];
    return h('span', { class: change < 0 ? 'text-danger' : change > 0 ? 'text-success' : C.muted, text: `${s.label}: ${change > 0 ? '+' : ''}${money(change)} (first → last point)` });
  })));
  return { element, dispose: () => observer?.disconnect() };
}
