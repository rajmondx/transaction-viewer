import { spendingCoverage, sumSpending, type SpendingPoint, type SpendingTotals } from '../spendingHistory';
import { C, clear, dmy, h, money, num0, num2 } from './util';

export type SpendingMetric = 'income' | 'expenses' | 'net' | 'transactions' | 'categorized';
export const SPENDING_METRICS: Array<{ key: SpendingMetric; label: string; color: string; dash: string }> = [
  { key: 'income', label: 'Income', color: 'var(--success)', dash: '' },
  { key: 'expenses', label: 'Expenses', color: 'var(--danger)', dash: '6 3' },
  { key: 'net', label: 'Net', color: 'var(--primary)', dash: '2 3' },
  { key: 'transactions', label: 'Transactions', color: 'var(--warning)', dash: '' },
  { key: 'categorized', label: 'Categorized', color: 'var(--success)', dash: '' },
];

/** One timeline with independently scaled lanes and a crosshair shared by all
 * selected metrics. Counts and percentages never share the money scale. */
export function spendingTimeline(points: SpendingPoint[], selected: Set<SpendingMetric>): { element: HTMLElement; dispose: () => void } {
  const element = h('div', { class: 'min-w-0' });
  const readout = h('div', { class: 'mb-2 flex min-h-12 flex-wrap items-center gap-x-5 gap-y-1 text-xs tabular-nums', attrs: { 'aria-live': 'polite', 'aria-atomic': 'true', 'data-spending-readout': '' } });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'block w-full outline-none focus-visible:ring-2 focus-visible:ring-primary');
  svg.setAttribute('tabindex', '0');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Spending summary timeline. Use Left and Right arrow keys to inspect periods, Home and End for first and last, Escape for range totals.');
  svg.style.touchAction = 'pan-y';
  element.appendChild(readout); element.appendChild(svg);
  const visible = SPENDING_METRICS.filter((metric) => selected.has(metric.key));
  const monetary = visible.filter((m): m is typeof m & { key: 'income' | 'expenses' | 'net' } => ['income', 'expenses', 'net'].includes(m.key));
  const hasCount = selected.has('transactions'), hasCoverage = selected.has('categorized');
  const firstTime = Date.parse(points[0].from), lastTime = Date.parse(points.at(-1)!.date) + 86400000;
  const times = points.map((p) => [Date.parse(p.from), Date.parse(p.date) + 86400000]);
  const totals = sumSpending(points);
  let width = 600, inspection: number | null = null;
  const left = 76, right = 14;
  let bottom = 12;
  const moneyTop = bottom + 22, moneyBottom = moneyTop + 190;
  if (monetary.length) bottom = moneyBottom + 20;
  const countTop = bottom + 22, countBottom = countTop + 72;
  if (hasCount) bottom = countBottom + 20;
  const coverageTop = bottom + 22, coverageBottom = coverageTop + 20;
  if (hasCoverage) bottom = coverageBottom + 20;
  const height = bottom + 25;
  svg.setAttribute('height', String(height));
  let low = 0, high = 0, maxCount = 1;
  for (const p of points) {
    if (p.excluded) continue;
    for (const m of monetary) { low = Math.min(low, p[m.key]); high = Math.max(high, p[m.key]); }
    maxCount = Math.max(maxCount, p.transactions);
  }
  const padding = Math.max((high - low) * 0.1, 1);
  low = low < 0 ? low - padding : 0;
  high = high > 0 ? high + padding : padding;
  const y = (value: number): number => moneyTop + (high - value) / (high - low) * (moneyBottom - moneyTop);
  const xTime = (time: number): number => left + (time - firstTime) / Math.max(1, lastTime - firstTime) * (width - left - right);
  const x = (i: number): number => xTime((times[i][0] + times[i][1]) / 2);
  let crosshair: SVGElement;
  let markers: SVGElement[] = [];
  const ns = 'http://www.w3.org/2000/svg';
  function node(tag: string, attrs: Record<string, string | number>, text?: string): SVGElement {
    const el = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
    if (text !== undefined) el.textContent = text;
    svg.appendChild(el);
    return el;
  }
  function showTotals(label: string, values: SpendingTotals, excluded = false): void {
    clear(readout);
    readout.appendChild(h('strong', { text: label }));
    if (excluded) { readout.appendChild(h('span', { class: C.muted, text: 'Hidden by month filters' })); return; }
    for (const metric of visible) {
      let value: string;
      if (metric.key === 'categorized') {
        const coverage = spendingCoverage(values);
        value = coverage === null ? 'No expenses' : `${coverage.toFixed(1)}% · ${money(values.expenses - values.categorizedAmount)} uncategorized`;
      } else value = metric.key === 'transactions' ? num0(values.transactions) : money(values[metric.key]);
      readout.appendChild(h('span', { style: { color: metric.color }, text: `${metric.label}: ${value}` }));
    }
  }
  function inspect(index: number | null): void {
    inspection = index;
    crosshair.setAttribute('visibility', index === null ? 'hidden' : 'visible');
    markers.forEach((marker) => marker.setAttribute('visibility', index === null || points[index].excluded ? 'hidden' : 'visible'));
    if (index === null) { showTotals('Selected range', totals); return; }
    const p = points[index];
    crosshair.setAttribute('x1', String(x(index))); crosshair.setAttribute('x2', String(x(index)));
    markers.forEach((marker, i) => { marker.setAttribute('cx', String(x(index))); marker.setAttribute('cy', String(y(p[monetary[i].key]))); });
    showTotals(p.from === p.date ? dmy(p.date) : `${dmy(p.from)} – ${dmy(p.date)}`, p, p.excluded);
  }
  function draw(): void {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    if (monetary.length) {
      node('text', { x: left, y: moneyTop - 10, fill: 'var(--muted-foreground)', 'font-size': 11, 'data-lane': 'money' }, width < 360 ? 'Money · CHF' : 'Income / Expenses / Net · CHF');
      for (let i = 0; i <= 4; i++) {
        const value = low + (high - low) * i / 4;
        node('line', { x1: left, x2: width - right, y1: y(value), y2: y(value), stroke: 'var(--border)' });
        node('text', { x: left - 8, y: y(value) + 4, 'text-anchor': 'end', fill: 'var(--muted-foreground)', 'font-size': 10 }, Math.abs(value) >= 10000 ? `${num2(value / 1000)}k` : num2(value));
      }
      node('line', { x1: left, x2: width - right, y1: y(0), y2: y(0), stroke: 'var(--muted-foreground)', 'stroke-dasharray': '3 3' });
      for (const m of monetary) {
        let path = '', move = true;
        points.forEach((p, i) => {
          if (p.excluded) { move = true; return; }
          path += `${move ? 'M' : 'L'}${x(i).toFixed(2)},${y(p[m.key]).toFixed(2)} `;
          move = false;
        });
        node('path', { d: path, stroke: m.color, fill: 'none', 'stroke-width': 2, 'stroke-dasharray': m.dash, 'stroke-linejoin': 'round', 'data-metric': m.key });
        // Isolated points (including a single yearly bucket) must remain visible.
        points.forEach((p, i) => {
          if (!p.excluded && (points.length === 1 || (i === 0 || points[i - 1].excluded) && (i === points.length - 1 || points[i + 1].excluded)))
            node('circle', { cx: x(i), cy: y(p[m.key]), r: 3, fill: m.color });
        });
      }
    }
    if (hasCount) {
      node('text', { x: left, y: countTop - 10, fill: 'var(--muted-foreground)', 'font-size': 11, 'data-lane': 'transactions' }, 'Transactions · count');
      for (const value of [0, maxCount]) {
        const cy = countBottom - value / maxCount * (countBottom - countTop);
        node('line', { x1: left, x2: width - right, y1: cy, y2: cy, stroke: 'var(--border)' });
        node('text', { x: left - 8, y: cy + 4, 'text-anchor': 'end', fill: 'var(--muted-foreground)', 'font-size': 10 }, num0(value));
      }
      points.forEach((p, i) => {
        if (p.excluded) return;
        const slot = xTime(times[i][1]) - xTime(times[i][0]);
        const barWidth = Math.max(0.25, Math.min(36, slot * 0.7));
        const barHeight = p.transactions / maxCount * (countBottom - countTop);
        node('rect', { x: x(i) - barWidth / 2, y: countBottom - barHeight, width: barWidth, height: barHeight, fill: 'var(--warning)', 'data-metric': 'transactions' });
      });
    }
    if (hasCoverage) {
      node('text', { x: left, y: coverageTop - 10, fill: 'var(--muted-foreground)', 'font-size': 11, 'data-lane': 'categorized' }, width < 360 ? 'Categorized · %' : 'Categorized · expense value %');
      points.forEach((p, i) => {
        const start = xTime(times[i][0]);
        const slot = Math.max(0.25, xTime(times[i][1]) - start - 1);
        const coverage = p.excluded ? null : spendingCoverage(p);
        const background = node('rect', { x: start, y: coverageTop, width: slot, height: 20, fill: p.excluded || coverage === null ? 'var(--muted)' : 'var(--warning)', 'data-metric': 'categorized' });
        const title = document.createElementNS(ns, 'title');
        title.textContent = p.excluded ? 'Hidden month' : coverage === null ? 'No expenses' : `${coverage.toFixed(1)}% categorized`;
        background.appendChild(title);
        if (coverage !== null) node('rect', { x: start, y: coverageTop, width: slot * Math.max(0, Math.min(100, coverage)) / 100, height: 20, fill: 'var(--success)' });
      });
    }
    node('text', { x: left, y: height - 6, fill: 'var(--muted-foreground)', 'font-size': 10 }, dmy(points[0].from));
    node('text', { x: width - right, y: height - 6, fill: 'var(--muted-foreground)', 'font-size': 10, 'text-anchor': 'end' }, dmy(points.at(-1)!.date));
    crosshair = node('line', { y1: 12, y2: bottom, stroke: 'var(--muted-foreground)', 'stroke-dasharray': '3 3', 'pointer-events': 'none' });
    markers = monetary.map((m) => node('circle', { r: 3.5, fill: m.color, stroke: 'var(--card)', 'stroke-width': 1.5, 'pointer-events': 'none' }));
    inspect(inspection);
  }
  svg.onpointermove = svg.onpointerdown = (event: PointerEvent) => {
    const rect = svg.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, ((event.clientX - rect.left) * width / rect.width - left) / (width - left - right)));
    const target = firstTime + fraction * (lastTime - firstTime);
    let lo = 0, hi = points.length - 1;
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (times[mid][1] <= target) lo = mid + 1; else hi = mid; }
    inspect(lo);
  };
  svg.onpointerleave = () => inspect(null);
  svg.onblur = () => inspect(null);
  svg.onkeydown = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return;
    event.preventDefault();
    inspect(event.key === 'Escape' ? null : event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1
      : inspection === null ? event.key === 'ArrowLeft' ? points.length - 1 : 0
      : Math.max(0, Math.min(points.length - 1, inspection + (event.key === 'ArrowLeft' ? -1 : 1))));
  };
  draw();
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => {
    if (!element.isConnected) { observer?.disconnect(); return; }
    const next = Math.max(240, Math.round(element.getBoundingClientRect().width));
    if (next !== width) { width = next; draw(); }
  });
  observer?.observe(element);
  return { element, dispose: () => observer?.disconnect() };
}
