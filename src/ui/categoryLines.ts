import { categoryRangeTotals, categoryTrendValue, type CategoryPeriod, type CategoryUnit, type TrendCategory } from '../categoryHistory';
import { C, clear, dmy, h, money, num2 } from './util';

/** Category lines use a common time axis and inspect all selected categories
 * together. Missing percentage denominators and hidden months break the paths. */
export function categoryLines(points: CategoryPeriod[], categories: TrendCategory[], unit: CategoryUnit, rootTags: string[]): { element: HTMLElement; dispose: () => void } {
  const element = h('div', { class: 'min-w-0' });
  const readout = h('div', { class: 'mb-2 flex min-h-12 flex-wrap items-center gap-x-5 gap-y-1 text-xs tabular-nums', attrs: { 'aria-live': 'polite', 'aria-atomic': 'true', 'data-category-readout': '' } });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'block w-full outline-none focus-visible:ring-2 focus-visible:ring-primary');
  svg.setAttribute('height', '260'); svg.setAttribute('tabindex', '0'); svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Category trends in ${unit}. Use Left and Right arrow keys to inspect periods, Home and End for first and last, Escape for range totals.`);
  svg.style.touchAction = 'pan-y';
  element.appendChild(readout); element.appendChild(svg);
  const totals = categoryRangeTotals(points, rootTags);
  const times = points.map((p) => [Date.parse(p.from), Date.parse(p.date) + 86400000]);
  const first = times[0][0], last = times.at(-1)![1];
  let width = 600, inspection: number | null = null;
  const left = 76, right = 14;
  const x = (index: number): number => left + ((times[index][0] + times[index][1]) / 2 - first) / (last - first) * (width - left - right);
  let low = 0, high = 0;
  const values = categories.map((category) => points.map((point) => categoryTrendValue(point, category.tag, unit)));
  for (const series of values) for (const value of series) if (value !== null) { low = Math.min(low, value); high = Math.max(high, value); }
  const margin = Math.max((high - low) * 0.1, 1);
  low = low < 0 ? low - margin : 0;
  high = high > 0 ? high + margin : unit === '%' ? 100 : 1;
  const y = (value: number): number => 16 + (high - value) / (high - low) * 212;
  const ns = 'http://www.w3.org/2000/svg';
  let crosshair: SVGElement;
  let markers: SVGElement[] = [];
  function node(tag: string, attrs: Record<string, string | number>, text?: string): SVGElement {
    const el = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
    if (text !== undefined) el.textContent = text;
    svg.appendChild(el);
    return el;
  }
  function inspect(index: number | null): void {
    inspection = index;
    crosshair.setAttribute('visibility', index === null ? 'hidden' : 'visible');
    if (index !== null) { crosshair.setAttribute('x1', String(x(index))); crosshair.setAttribute('x2', String(x(index))); }
    markers.forEach((marker, i) => {
      const value = index === null ? null : values[i][index];
      marker.setAttribute('visibility', value === null ? 'hidden' : 'visible');
      if (index !== null && value !== null) { marker.setAttribute('cx', String(x(index))); marker.setAttribute('cy', String(y(value))); }
    });
    clear(readout);
    const point = index === null ? totals : points[index];
    readout.appendChild(h('strong', { text: index === null ? 'Selected range' : point.from === point.date ? dmy(point.date) : `${dmy(point.from)} – ${dmy(point.date)}` }));
    if (point.excluded) { readout.appendChild(h('span', { class: C.muted, text: 'Hidden by month filters' })); return; }
    for (const category of categories) {
      const amount = point.values.get(category.tag) ?? 0;
      const share = categoryTrendValue(point, category.tag, '%');
      const shareText = share === null ? 'Share unavailable (zero total)' : `${num2(share)}%`;
      readout.appendChild(h('span', { class: 'min-w-0 break-words', style: { color: category.color }, text: `${category.label}: ${unit === '%' ? `${shareText} · ${money(amount)}` : `${money(amount)} · ${shareText}`}` }));
    }
  }
  function draw(): void {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    svg.setAttribute('viewBox', `0 0 ${width} 260`);
    for (let i = 0; i <= 4; i++) {
      const value = low + (high - low) * i / 4;
      node('line', { x1: left, x2: width - right, y1: y(value), y2: y(value), stroke: 'var(--border)' });
      const label = (Math.abs(value) >= 10000 ? `${num2(value / 1000)}k` : num2(value)) + (unit === '%' ? '%' : '');
      node('text', { x: left - 8, y: y(value) + 4, 'text-anchor': 'end', fill: 'var(--muted-foreground)', 'font-size': 10 }, label);
    }
    if (low < 0) node('line', { x1: left, x2: width - right, y1: y(0), y2: y(0), stroke: 'var(--muted-foreground)', 'stroke-dasharray': '3 3' });
    categories.forEach((category, ci) => {
      let path = '', move = true;
      values[ci].forEach((value, i) => {
        if (value === null) { move = true; return; }
        path += `${move ? 'M' : 'L'}${x(i).toFixed(2)},${y(value).toFixed(2)} `;
        move = false;
      });
      node('path', { d: path, stroke: category.color, fill: 'none', 'stroke-width': 2, 'stroke-dasharray': category.dash, 'stroke-linejoin': 'round', 'data-category-line': category.tag });
      values[ci].forEach((value, i, all) => {
        if (value !== null && (i === 0 || all[i - 1] === null) && (i === all.length - 1 || all[i + 1] === null))
          node('circle', { cx: x(i), cy: y(value), r: 3, fill: category.color });
      });
    });
    node('text', { x: left, y: 250, fill: 'var(--muted-foreground)', 'font-size': 10 }, dmy(points[0].from));
    node('text', { x: width - right, y: 250, 'text-anchor': 'end', fill: 'var(--muted-foreground)', 'font-size': 10 }, dmy(points.at(-1)!.date));
    crosshair = node('line', { y1: 12, y2: 228, stroke: 'var(--muted-foreground)', 'stroke-dasharray': '3 3', 'pointer-events': 'none' });
    markers = categories.map((category) => node('circle', { r: 3.5, fill: category.color, stroke: 'var(--card)', 'stroke-width': 1.5, 'pointer-events': 'none' }));
    inspect(inspection);
  }
  svg.onpointermove = svg.onpointerdown = (event: PointerEvent) => {
    const rect = svg.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, ((event.clientX - rect.left) * width / rect.width - left) / (width - left - right)));
    const target = first + fraction * (last - first);
    let lo = 0, hi = points.length - 1;
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (times[mid][1] <= target) lo = mid + 1; else hi = mid; }
    inspect(lo);
  };
  svg.onpointerleave = () => inspect(null); svg.onblur = () => inspect(null);
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
