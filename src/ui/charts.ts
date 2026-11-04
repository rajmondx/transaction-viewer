import { num2, readableOn } from './util';
import { attachDragPan } from './dragScroll';

export interface Series {
  name: string;
  color: string;
  values: number[];
}

/**
 * Stacked bar chart (SVG). bars = one per month; each stack splits into series values.
 * Signed values are possible (Net view): positive segments stack up from the zero
 * baseline, negative ones hang below it. With only non-negative values the baseline is
 * the plot bottom, i.e. the classic stack.
 *
 * The SVG is drawn at 1:1 pixel scale — the viewBox always matches its own size — so
 * month labels and totals are never stretched. The width follows the space available in
 * the card (between 64 and 190 px per month): a couple of months do not sprawl over the
 * whole card, many months scroll horizontally instead of squeezing their labels together
 * — and can be dragged sideways to scroll (see dragScroll.ts).
 *
 * `opts.onMonthClick` makes every month column a click target (the Spending page opens
 * its single-month detail from it). The column-wide hit rect sits *below* the segments,
 * so the per-segment tooltips keep working; clicking a segment or the label does the
 * same as clicking the column.
 * Returns an HTMLElement.
 */
export function stackedBars(
  months: string[],
  series: Series[],
  height = 260,
  opts: { onMonthClick?: (index: number) => void } = {},
): HTMLElement {
  const clickable = !!opts.onMonthClick;
  const NS = 'http://www.w3.org/2000/svg';
  const MIN_SLOT = 64; // px per month — enough for "Oct 2026" plus the total
  const MAX_SLOT = 190; // px per month — the chart does not thin out over few months
  const padL = 8;
  const padB = 26;
  const nMonths = Math.max(1, months.length);

  const wrap = document.createElement('div');
  wrap.className = 'overflow-x-auto';
  // many months: the chart is wider than the card — grab and slide to scroll it
  attachDragPan(wrap);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'block');
  svg.style.height = `${height}px`;
  wrap.appendChild(svg);

  /** fit the month slots to the room we have, but stay inside the 64..190 px range */
  const widthFor = (avail: number): number => {
    const min = Math.max(320, nMonths * MIN_SLOT);
    if (!Number.isFinite(avail) || avail <= 0) return min; // not measured (server/test) — plain fallback
    return Math.round(Math.min(Math.max(avail, min), Math.max(min, nMonths * MAX_SLOT)));
  };

  const draw = (width: number, avail: number): void => {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.style.width = `${width}px`;
    // center it only when it really is narrower than the card — the available width is
    // passed in, because reading it here would force a layout while the tab is rendering
    svg.style.margin = width < avail ? '0 auto' : '';

    const totals = months.map((_, i) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
    const stackPos = months.map((_, i) => series.reduce((s, x) => s + Math.max(0, x.values[i] ?? 0), 0));
    const stackNeg = months.map((_, i) => series.reduce((s, x) => s + Math.min(0, x.values[i] ?? 0), 0)); // ≤ 0
    const maxNeg = Math.min(0, ...stackNeg);
    const plotH = height - padB - 12;
    // split the plot so the tallest positive and the deepest negative stack both fit
    const scale = plotH / Math.max(1, Math.max(0, ...stackPos) - maxNeg);
    const zeroY = 12 + plotH + maxNeg * scale;
    const barW = (width - padL * 2) / nMonths;
    const bw = Math.min(40, barW * 0.6);

    if (maxNeg < 0) {
      const base = document.createElementNS(NS, 'line');
      base.setAttribute('x1', '0');
      base.setAttribute('x2', String(width));
      base.setAttribute('y1', String(zeroY));
      base.setAttribute('y2', String(zeroY));
      base.setAttribute('class', 'stroke-border');
      svg.appendChild(base);
    }

    for (let mi = 0; mi < months.length; mi++) {
      // full-column click target under the segments (see the .month-hit rule in styles.css)
      if (clickable) {
        const hit = document.createElementNS(NS, 'rect');
        hit.setAttribute('x', String(padL + mi * barW));
        hit.setAttribute('y', '8');
        hit.setAttribute('width', String(barW));
        hit.setAttribute('height', String(height - 8));
        hit.setAttribute('class', 'month-hit');
        const ht = document.createElementNS(NS, 'title');
        ht.textContent = `${months[mi]} — click for month detail`;
        hit.appendChild(ht);
        hit.onclick = () => opts.onMonthClick?.(mi);
        svg.appendChild(hit);
      }
      let up = zeroY; // current top edge of the positive stack
      let down = zeroY; // current bottom edge of the negative stack
      for (const s of series) {
        const v = s.values[mi] ?? 0;
        if (v === 0) continue;
        const hh = Math.abs(v) * scale;
        let top: number;
        if (v > 0) {
          up -= hh;
          top = up;
        } else {
          top = down;
          down += hh;
        }
        const rect = document.createElementNS(NS, 'rect');
        rect.setAttribute('x', String(padL + mi * barW + (barW - bw) / 2));
        rect.setAttribute('y', String(top));
        rect.setAttribute('width', String(bw));
        rect.setAttribute('height', String(hh));
        rect.setAttribute('fill', s.color);
        if (clickable) {
          rect.setAttribute('class', 'cursor-pointer');
          rect.onclick = () => opts.onMonthClick?.(mi);
        }
        const t = document.createElementNS(NS, 'title');
        t.textContent = `${s.name} — ${months[mi]}: CHF ${num2(v)}`;
        rect.appendChild(t);
        svg.appendChild(rect);
      }
      const centerX = String(padL + mi * barW + barW / 2);
      const label = document.createElementNS(NS, 'text');
      label.setAttribute('x', centerX);
      label.setAttribute('y', String(height - 8));
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('class', clickable ? 'fill-muted-foreground text-[10px] cursor-pointer' : 'fill-muted-foreground text-[10px]');
      if (clickable) label.onclick = () => opts.onMonthClick?.(mi);
      label.textContent = months[mi]; // already formatted by the caller (e.g. 'Oct 2026')
      svg.appendChild(label);
      if (totals[mi] !== 0) {
        const tot = document.createElementNS(NS, 'text');
        tot.setAttribute('x', centerX);
        tot.setAttribute('y', String(totals[mi] > 0 ? up - 4 : down + 9));
        tot.setAttribute('text-anchor', 'middle');
        tot.setAttribute('class', 'fill-muted-foreground text-[9px]');
        tot.textContent = Math.round(totals[mi]).toLocaleString('de-CH');
        svg.appendChild(tot);
      }
    }
  };

  let lastWidth = widthFor(0);
  draw(lastWidth, 0);

  // follow the card's width once mounted (and on resize); plain fallback where there is no DOM
  if (typeof ResizeObserver !== 'undefined' && typeof wrap.getBoundingClientRect === 'function') {
    const ro = new ResizeObserver(() => {
      if (!wrap.isConnected) {
        ro.disconnect();
        return;
      }
      // the grab cursor only while the chart really is wider than the card
      wrap.classList.toggle('cursor-grab', wrap.scrollWidth > wrap.clientWidth + 1);
      const avail = wrap.getBoundingClientRect().width;
      const w = widthFor(avail);
      if (w !== lastWidth) {
        lastWidth = w;
        draw(w, avail);
      }
    });
    ro.observe(wrap);
  }

  const legend = document.createElement('div');
  legend.className = 'mt-2 flex flex-wrap gap-2.5';
  for (const s of series) {
    const item = document.createElement('span');
    item.className = 'flex items-center gap-1.5 text-xs';
    const dot = document.createElement('span');
    dot.className = 'size-2.5 shrink-0';
    dot.style.background = s.color;
    item.appendChild(dot);
    item.appendChild(document.createTextNode(s.name));
    legend.appendChild(item);
  }
  wrap.appendChild(legend);
  return wrap;
}

/** One row of the share chart. `depth: 1` marks a sub-category of the row above it.
 *  `note` fills an extra right-aligned detail column (only rendered when any row
 *  carries one) — the Spending month view uses it for the transaction count. */
export interface ShareItem {
  name: string;
  color: string;
  value: number;
  depth?: number;
  note?: string;
}

/**
 * Category shares as horizontal bars.
 *
 * From tablet width up, the name is its own column (as wide as the longest one,
 * so it stays fully readable) and the bar takes the rest. On mobile there is no
 * room for both, so the name goes **inside** the bar — in a color that contrasts
 * with the fill — or right after it when the bar is too short. Percent and amount
 * always keep their own columns.
 *
 * `depth: 1` rows are grouped into the block of the `depth: 0` row above them.
 * Options: `total` (signed headline sum) and `denominator` (what a percentage is
 * relative to — pass the top-level magnitudes so parent and children do not
 * count twice). Rows are rendered in the order given; ranking and capping is the
 * caller's job.
 */
export function shareBars(
  items: ShareItem[],
  totalLabel: string,
  opts: { total?: number; denominator?: number } = {},
): HTMLElement {
  const NAME_MIN = 72; // px
  const NAME_MAX = 240; // wider names truncate, the full text is in the tooltip
  const MOBILE = 640; // Tailwind's sm: below this the name goes into the bar

  const wide = (): boolean =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(`(min-width: ${MOBILE}px)`).matches
      : true;

  const wrap = document.createElement('div');
  wrap.className = 'flex flex-col gap-1.5';
  const sum = opts.total ?? items.reduce((s, x) => s + x.value, 0);
  const absSum = opts.denominator ?? items.reduce((s, x) => s + Math.abs(x.value), 0);
  const head = document.createElement('div');
  head.className = 'mb-1 font-semibold';
  head.textContent = `${totalLabel}: CHF ${num2(sum)}`;
  wrap.appendChild(head);

  interface Row { row: HTMLElement; name: HTMLElement; track: HTMLElement; label: HTMLElement; pct: number; color: string; depth: number }
  const rows: Row[] = [];
  let group: HTMLElement | null = null;
  // the detail column only appears when at least one row carries a note
  const hasNote = items.some((it) => (it.note ?? '') !== '');
  const NOTE_COL = 64; // px

  for (const it of items) {
    if (Math.abs(it.value) === 0) continue;
    const depth = it.depth ?? 0;
    if (depth === 0 || !group) {
      // one block per top-level category: its sub-categories hang right under it
      group = document.createElement('div');
      group.className = 'flex flex-col gap-[2px]';
      wrap.appendChild(group);
    }
    const pct = absSum > 0 ? (Math.abs(it.value) / absSum) * 100 : 0;

    const name = document.createElement('span');
    name.className = depth > 0 ? 'truncate text-[12px] text-muted-foreground' : 'truncate text-[12.5px]';
    name.textContent = it.name;
    name.title = it.name;
    if (depth > 0) name.style.paddingLeft = '14px';

    const bar = document.createElement('div');
    bar.className = 'absolute inset-y-[3px] left-0';
    bar.style.background = it.color;
    bar.style.width = `${pct}%`;

    const label = document.createElement('span');
    label.className = 'absolute inset-y-0 left-0 flex items-center whitespace-nowrap';
    label.textContent = it.name;
    label.title = it.name;

    const track = document.createElement('div');
    track.className = 'relative h-5 overflow-hidden';
    track.appendChild(bar);
    track.appendChild(label);

    // percent and amount get their own fixed-width, right-aligned columns so the numbers line up across rows
    const pctEl = document.createElement('span');
    pctEl.className = 'truncate text-right text-muted-foreground tabular-nums';
    pctEl.textContent = `${pct.toFixed(1)}%`;
    const valEl = document.createElement('span');
    valEl.className = 'truncate text-right text-muted-foreground tabular-nums';
    valEl.textContent = num2(it.value); // currency is stated once in the headline, not on every row

    const row = document.createElement('div');
    // zebra striping like the CSV/Spending tables — alternating over all rows,
    // including the sub-category rows inside a group
    row.className = 'grid items-center gap-2 text-xs ' + (rows.length % 2 === 1 ? 'bg-zebra' : 'bg-card');
    // start mobile-style (name inside the bar); apply() switches once the size is known
    row.style.gridTemplateColumns = hasNote ? `1fr 48px 92px ${NOTE_COL}px` : '1fr 48px 92px';
    name.style.display = 'none';
    row.appendChild(name);
    row.appendChild(track);
    row.appendChild(pctEl);
    row.appendChild(valEl);
    if (hasNote) {
      const noteEl = document.createElement('span');
      noteEl.className = 'truncate text-right text-[11px] text-muted-foreground tabular-nums';
      noteEl.textContent = it.note ?? '';
      noteEl.title = it.note ?? '';
      row.appendChild(noteEl);
    }
    group.appendChild(row);
    rows.push({ row, name, track, label, pct, color: it.color, depth });
  }
  if (rows.length === 0) wrap.appendChild(document.createTextNode('nothing to show'));

  /** name column on wide screens, in-bar label on mobile */
  const apply = (): void => {
    const isWide = wide();
    for (const r of rows) {
      r.name.style.display = isWide ? '' : 'none';
      r.label.style.display = isWide ? 'none' : '';
    }
    let nameW = 0;
    if (isWide) {
      for (const r of rows) nameW = Math.max(nameW, r.name.offsetWidth ?? 0);
      nameW = Math.min(NAME_MAX, Math.max(NAME_MIN, nameW + 2));
    }
    for (const r of rows) {
      r.row.style.gridTemplateColumns = isWide
        ? `${nameW}px 1fr 48px 92px${hasNote ? ` ${NOTE_COL}px` : ''}`
        : `1fr 48px 92px${hasNote ? ` ${NOTE_COL}px` : ''}`;
      // on mobile there is no name column to indent, so the bar itself steps in for a sub-category
      r.track.style.marginLeft = !isWide && r.depth > 0 ? '12px' : '0px';
      if (isWide) continue;
      const trackW = r.track.clientWidth ?? 0;
      const labelW = r.label.offsetWidth ?? 0;
      if (!trackW || !labelW) continue; // not laid out yet — the observer runs this again
      const barW = (r.pct / 100) * trackW;
      const inside = barW >= labelW + 14 || trackW - barW < labelW + 10;
      r.label.style.left = inside ? '6px' : `${Math.round(barW) + 6}px`;
      r.label.style.color = inside ? readableOn(r.color) : '';
    }
  };

  // the first measurement only works once the element is in the document — a
  // ResizeObserver fires on mount and then on every width change
  if (typeof ResizeObserver !== 'undefined' && typeof wrap.getBoundingClientRect === 'function') {
    const ro = new ResizeObserver(() => {
      if (!wrap.isConnected) {
        ro.disconnect();
        return;
      }
      apply();
    });
    ro.observe(wrap);
  } else {
    apply();
  }

  return wrap;
}
