import { C, cx, dmy, h, num2, toast } from './util';

/**
 * Printer-friendly output for the Spending and CSV tables.
 *
 * The app page itself is never printed (dark theme, sticky columns, scroll
 * containers and the option modal would all leak onto paper). Instead every
 * print builds a self-contained HTML document — white background, black text,
 * monospace, bordered tables, repeating header rows — writes it into a hidden
 * same-origin iframe, and opens the browser's native print dialog on it.
 * The doc builders are pure string functions (plain data in, HTML out) so
 * they can be unit-tested without a DOM.
 */

export interface PrintOptions {
  /** request landscape pages from the printer */
  landscape?: boolean;
  /** body font family (defaults to the monospace stack) */
  font?: PrintFont;
  /** body font size in points (default 10 — headings and small text scale with it) */
  sizePt?: number;
  /** add 'page n / total' centered at the bottom of every page */
  pageNumbers?: boolean;
}

export type PrintFont = 'mono' | 'sans' | 'serif';

/** the three families offered in the dialog — all render fine on paper */
const FONT_STACKS: Record<PrintFont, string> = {
  mono: "ui-monospace, 'Cascadia Mono', 'Consolas', monospace",
  sans: "system-ui, 'Segoe UI', Arial, sans-serif",
  serif: "Cambria, Georgia, 'Times New Roman', serif",
};

/** Escape text for safe embedding in the generated HTML document. */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Printer stylesheet: monochrome only, tables that break across pages.
 * Sizes are em-based so the font-size picker scales the whole document.
 */
export function printCss(opts: PrintOptions = {}): string {
  const page = `@page { margin: 12mm${opts.landscape ? '; size: A4 landscape' : ''};` +
    // CSS page margin boxes: modern Chromium/Firefox/Safari; older browsers silently skip the numbers
    `${opts.pageNumbers ? ' @bottom-center { content: counter(page) " / " counter(pages); font-size: 8.5pt; color: #000; }' : ''} }`;
  return [
    page,
    '* { box-sizing: border-box; }',
    'html, body { margin: 0; padding: 0; background: #fff; color: #000; }',
    `body { font-family: ${FONT_STACKS[opts.font ?? 'mono']}; font-size: ${opts.sizePt ?? 10}pt; line-height: 1.4; }`,
    'h1 { font-size: 1.5em; margin: 0 0 2px; }',
    'h2 { font-size: 1.1em; margin: 16px 0 5px; }',
    '.head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }',
    '.head .pdate { font-size: 0.85em; white-space: nowrap; }',
    '.meta { font-size: 0.85em; margin: 0 0 10px; }',
    '.meta p { margin: 1px 0; }',
    'table { border-collapse: collapse; width: 100%; }',
    'thead { display: table-header-group; }',
    // tfoot would repeat on every page as a footer group — print the totals once, after the last row
    'tfoot { display: table-row-group; }',
    'tr { page-break-inside: avoid; break-inside: avoid; }',
    'th, td { border: 1px solid #000; padding: 2px 6px; text-align: left; vertical-align: top; font-weight: normal; }',
    'th { font-weight: bold; white-space: nowrap; }',
    '.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }',
    '.nl { white-space: pre-line; }', // merged booking/value cells break onto two lines despite .num
    'td.name { white-space: nowrap; }',
    'td.wrap { white-space: normal; word-break: break-word; }',
    'td.bar { white-space: nowrap; width: 1%; }',
    '.total { font-weight: bold; }',
    'tfoot td { border-top-width: 2px; }',
    '.graphs { break-before: page; page-break-before: always; }', // the chart section starts on its own page
    'table.summary { width: auto; }',
    'table.summary td { border: 0; padding: 2px 18px 2px 0; }',
    'table.summary span { display: block; font-size: 0.8em; }',
    '.sharehead { margin: 2px 0 6px; font-weight: bold; }',
    '.hatchdefs { position: absolute; width: 0; height: 0; }',
    'svg.chart { display: block; max-width: 100%; }',
    'svg text { fill: #000; font-size: 9px; }',
    'svg text.tl { font-size: 8px; }',
    '.legend { display: flex; flex-wrap: wrap; gap: 3px 16px; margin-top: 6px; font-size: 0.9em; }',
    '.legend span { white-space: nowrap; }',
    '.legend svg { vertical-align: -1px; }',
  ].join('\n');
}

// ---- monochrome graphs ----------------------------------------------------------------

/** number of distinct hatch patterns available to colorize-free series */
const HATCH_COUNT = 10;
/** share bar length in characters at 100 % */
const BAR_CHARS = 24;

/**
 * Hidden SVG holding <pattern> defs referenced by every chart via url(#hpN).
 * Patterns are black-on-white strokes → legible on any monochrome printer.
 */
export function hatchDefs(): string {
  const pats = [
    '<pattern id="hp0" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" stroke="#000" stroke-width="1.2"/></pattern>',
    '<pattern id="hp1" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><line x1="0" y1="0" x2="0" y2="4" stroke="#000" stroke-width="1.2"/></pattern>',
    '<pattern id="hp2" width="4" height="4" patternUnits="userSpaceOnUse"><line x1="1" y1="0" x2="1" y2="4" stroke="#000" stroke-width="1.2"/></pattern>',
    '<pattern id="hp3" width="4" height="4" patternUnits="userSpaceOnUse"><line x1="0" y1="1" x2="4" y2="1" stroke="#000" stroke-width="1.2"/></pattern>',
    '<pattern id="hp4" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M0 0L8 8M8 0L0 8" stroke="#000" stroke-width="1"/></pattern>',
    '<pattern id="hp5" width="5" height="5" patternUnits="userSpaceOnUse"><path d="M0 .5H5M.5 0V5" stroke="#000" stroke-width="1"/></pattern>',
    '<pattern id="hp6" width="5" height="5" patternUnits="userSpaceOnUse"><circle cx="2.5" cy="2.5" r="1" fill="#000"/></pattern>',
    '<pattern id="hp7" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="8" stroke="#000" stroke-width="1.2"/></pattern>',
    '<pattern id="hp8" width="2.6" height="2.6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="2.6" stroke="#000" stroke-width="0.9"/></pattern>',
    '<pattern id="hp9" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="3" height="3" fill="#000"/><rect x="3" y="3" width="3" height="3" fill="#000"/></pattern>',
  ];
  return `<svg class="hatchdefs" aria-hidden="true"><defs>${pats.join('')}</defs></svg>`;
}

const n1 = (n: number): string => String(Math.round(n * 10) / 10);

/**
 * Stacked monthly bars as a monochrome SVG: same stacking geometry as
 * charts.stackedBars (positive up from the zero baseline, negative hanging
 * below it), but each series is identified by a hatch pattern instead of a
 * color. Returns the SVG string plus a hatched legend.
 */
export function stackedBarsPrint(months: string[], series: Array<{ name: string; values: number[] }>, height = 230): string {
  if (months.length === 0 || series.length === 0) return '<p class="meta">no chart data</p>';
  const width = Math.max(360, months.length * 64);
  const padL = 8;
  const padB = 26;
  const totals = months.map((_, i) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  const stackPos = months.map((_, i) => series.reduce((s, x) => s + Math.max(0, x.values[i] ?? 0), 0));
  const stackNeg = months.map((_, i) => series.reduce((s, x) => s + Math.min(0, x.values[i] ?? 0), 0));
  const maxNeg = Math.min(0, ...stackNeg);
  const plotH = height - padB - 12;
  const scale = plotH / Math.max(1, Math.max(0, ...stackPos) - maxNeg);
  const zeroY = 12 + plotH + maxNeg * scale;
  const barW = (width - padL * 2) / months.length;
  const bw = Math.min(40, barW * 0.6);

  const parts: string[] = [`<svg class="chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`];
  if (maxNeg < 0) parts.push(`<line x1="0" x2="${width}" y1="${n1(zeroY)}" y2="${n1(zeroY)}" stroke="#000" stroke-width="0.8"/>`);
  for (let mi = 0; mi < months.length; mi++) {
    let up = zeroY;
    let down = zeroY;
    series.forEach((s, si) => {
      const v = s.values[mi] ?? 0;
      if (v === 0) return;
      const hh = Math.abs(v) * scale;
      let top: number;
      if (v > 0) {
        up -= hh;
        top = up;
      } else {
        top = down;
        down += hh;
      }
      const x = padL + mi * barW + (barW - bw) / 2;
      parts.push(
        `<rect x="${n1(x)}" y="${n1(top)}" width="${n1(bw)}" height="${n1(hh)}" fill="url(#hp${si % HATCH_COUNT})" stroke="#000" stroke-width="0.9">` +
          `<title>${esc(`${s.name} — ${months[mi]}: CHF ${num2(v)}`)}</title></rect>`,
      );
    });
    const labelX = n1(padL + mi * barW + barW / 2);
    parts.push(`<text x="${labelX}" y="${height - 8}" text-anchor="middle">${esc(months[mi])}</text>`);
    if (totals[mi] !== 0) {
      parts.push(
        `<text class="tl" x="${labelX}" y="${n1(totals[mi] > 0 ? up - 4 : down + 9)}" text-anchor="middle">` +
          `${esc(Math.round(totals[mi]).toLocaleString('de-CH'))}</text>`,
      );
    }
  }
  parts.push('</svg>');
  const legend =
    `<div class="legend">${series
      .map(
        (s, si) =>
          `<span><svg width="11" height="11"><rect x="0.5" y="0.5" width="10" height="10" fill="url(#hp${si % HATCH_COUNT})" stroke="#000"/></svg>${esc(s.name)}</span>`,
      )
      .join('')}</div>`;
  return parts.join('') + legend;
}

/**
 * Category shares as monospace text bars (████) with aligned % and amount
 * columns — the same ranking semantics as charts.shareBars (signed headline,
 * bar length from |value|, top 12 by magnitude).
 */
export function shareBarsPrint(
  items: Array<{ name: string; value: number; amount: string }>,
  totalLabel: string,
  sumLabel: string,
): string {
  const absSum = items.reduce((s, x) => s + Math.abs(x.value), 0);
  const sorted = [...items]
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 12)
    .filter((x) => Math.abs(x.value) > 0);
  if (sorted.length === 0) return '<p class="meta">nothing to show</p>';
  const rows = sorted
    .map((it) => {
      const pct = absSum > 0 ? (Math.abs(it.value) / absSum) * 100 : 0;
      const bar = '█'.repeat(Math.max(1, Math.round((pct / 100) * BAR_CHARS)));
      return (
        `<tr><td class="name">${esc(it.name)}</td><td class="bar">${bar}</td>` +
        `<td class="num">${pct.toFixed(1)}%</td><td class="num">${esc(it.amount)}</td></tr>`
      );
    })
    .join('');
  return (
    `<div class="sharehead">${esc(totalLabel)}: ${esc(sumLabel)}</div>` +
    '<table class="shares"><thead><tr><th>Category</th><th>Share</th><th class="num">%</th><th class="num">Amount</th></tr></thead>' +
    `<tbody>${rows}</tbody></table>`
  );
}

// ---- merged-cell helpers (used by the CSV print dialog) --------------------------------

/** One amount column for income and expenses: explicit '+' / '−' sign. */
export function mergedAmountCell(credit: number, debit: number): string {
  if (credit > 0) return `+${num2(credit)}`;
  if (debit > 0) return `−${num2(debit)}`;
  return '';
}

/** Signed net shown in the totals row under a merged amount column. */
export function mergedNetTotal(credit: number, debit: number): string {
  const net = credit - debit;
  if (net > 0) return `+${num2(net)}`;
  if (net < 0) return `−${num2(-net)}`;
  return num2(0);
}

/** Booking + value date in one cell: printed once when equal, two lines when not. */
export function mergedDateCell(bookingIso: string, valueIso: string): string {
  const b = dmy(bookingIso);
  const v = dmy(valueIso);
  return b === v ? b : `${b} /\n${v}`;
}

/** Category merged into the description cell: `Housing > Rent — Miete Oktober`. */
export function mergedDescCell(text: string, category: string): string {
  return category ? `${category} — ${text}` : text;
}

// ---- document builders ------------------------------------------------------------------

function metaHtml(lines: string[]): string {
  return lines.length ? `<div class="meta">${lines.map((l) => `<p>${esc(l)}</p>`).join('')}</div>` : '';
}

/** Title row: document title left, optional print date top-right (smaller font). */
function docHead(title: string, printDate?: string): string {
  return `<div class="head"><h1>${esc(title)}</h1>${printDate ? `<div class="pdate">${esc(printDate)}</div>` : ''}</div>`;
}

function printDoc(title: string, opts: PrintOptions, body: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>` +
    `<style>${printCss(opts)}</style></head><body>${body}</body></html>`
  );
}

export interface SpendingPrintRow {
  name: string;
  /** tree depth; rendered as pure indentation (no colored dots) */
  depth: number;
  /** preformatted cell texts, one per month */
  cells: string[];
  /** preformatted row total */
  total: string;
  /** preformatted row average (total ÷ visible month count) — shown when the Average column is on */
  avg: string;
}

export interface SpendingPrintData {
  title: string;
  meta: string[];
  /** shown top-right next to the title when set (date only) */
  printDate?: string;
  summary: Array<{ label: string; value: string }>;
  measureName: string;
  months: string[];
  rows: SpendingPrintRow[];
  /** optional 'Total Income' / 'Total Expenses' / 'Total Net' footer rows rendered as a <tfoot> (left out when empty) */
  footer?: SpendingPrintRow[];
  stacked: { months: string[]; series: Array<{ name: string; values: number[] }> };
  share: { totalLabel: string; sumLabel: string; items: Array<{ name: string; value: number; amount: string }> };
}

/** Complete printable HTML document for the spending matrix (+ optional graphs). */
export function buildSpendingPrintDoc(
  d: SpendingPrintData,
  opts: {
    graphs: boolean;
    /** start the chart section on a new page; false = flow right after the table (default: true) */
    graphsNewPage?: boolean;
    /** add an Average column next to Total (default off) */
    average?: boolean;
    /** leave out the month columns — print Category, Total and Average only (implies `average`) */
    onlyAverages?: boolean;
  } & PrintOptions,
): string {
  // 'Only Averages' always shows the column too; the two dialog toggles are mutually exclusive
  const showAvg = opts.average === true || opts.onlyAverages === true;
  const months = opts.onlyAverages ? [] : d.months;
  const head =
    `<tr><th>Category</th>${months.map((m) => `<th class="num">${esc(m)}</th>`).join('')}` +
    `${showAvg ? '<th class="num">Average</th>' : ''}<th class="num">Total</th></tr>`;
  // Average before Total: the row total is the last number you read
  const printRow = (r: SpendingPrintRow): string =>
    `<tr><td class="name" style="padding-left:${6 + r.depth * 16}px">${esc(r.name)}</td>` +
    months.map((_, i) => `<td class="num">${esc(r.cells[i] ?? '')}</td>`).join('') +
    `${showAvg ? `<td class="num">${esc(r.avg)}</td>` : ''}` +
    `<td class="num total">${esc(r.total)}</td></tr>`;
  const body = d.rows.map(printRow).join('');
  // footer rows share the row layout; the print CSS keeps tfoot a plain row group
  // (printed once, after the last row) and draws the thicker separating line
  const tfoot = d.footer && d.footer.length ? `<tfoot>${d.footer.map(printRow).join('')}</tfoot>` : '';
  const summary = d.summary.length
    ? `<table class="summary"><tr>${d.summary
        .map((s) => `<td><span>${esc(s.label)}</span><b>${esc(s.value)}</b></td>`)
        .join('')}</tr></table>`
    : '';
  const graphs = opts.graphs
    ? `<div${opts.graphsNewPage === false ? '' : ' class="graphs"'}>${hatchDefs()}` +
      `<h2>Monthly — ${esc(d.measureName)}</h2>${stackedBarsPrint(d.stacked.months, d.stacked.series)}` +
      `<h2>Share</h2>${shareBarsPrint(d.share.items, d.share.totalLabel, d.share.sumLabel)}</div>`
    : '';
  return printDoc(
    d.title,
    opts,
    `${docHead(d.title, d.printDate)}${metaHtml(d.meta)}${summary}<table class="matrix"><thead>${head}</thead><tbody>${body}</tbody>${tfoot}</table>${graphs}`,
  );
}

export interface CsvPrintColumn {
  key: string;
  label: string;
  /** right-aligned, tabular */
  num?: boolean;
  /** allow multi-line wrapping (descriptions) */
  wrap?: boolean;
  /** keep '\n' line breaks inside the cell (merged booking/value dates) */
  nl?: boolean;
  /** print positive amounts in bold (income); negatives (−) and blanks stay regular */
  boldPositive?: boolean;
}

export interface CsvPrintData {
  title: string;
  meta: string[];
  /** shown top-right next to the title when set (date only) */
  printDate?: string;
  columns: CsvPrintColumn[];
  /** preformatted cell texts per row, aligned with `columns` */
  rows: string[][];
  /** column key -> formatted total (empty object omits the tfoot row) */
  totals: Record<string, string>;
}

/** Complete printable HTML document for the transaction list. */
export function buildCsvPrintDoc(d: CsvPrintData, opts: PrintOptions = {}): string {
  const head = `<tr>${d.columns.map((c) => `<th${c.num ? ' class="num"' : ''}>${esc(c.label)}</th>`).join('')}</tr>`;
  const body = d.rows
    .map(
      (r) =>
        `<tr>${r
          .map((v, i) => {
            const c = d.columns[i];
            const cls = cx(c.num && 'num', c.wrap && 'wrap', c.nl && 'nl');
            const bold = c.boldPositive === true && v !== '' && !v.startsWith('−') && !v.startsWith('-');
            const cell = bold ? `<b>${esc(v)}</b>` : esc(v);
            return `<td${cls ? ` class="${cls}"` : ''}>${cell}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('');
  const hasTotals = Object.keys(d.totals).length > 0;
  const foot = hasTotals
    ? `<tfoot><tr>${d.columns
        .map((c, i) => {
          const t = d.totals[c.key];
          if (t) return `<td${c.num ? ' class="num total"' : ' class="total"'}>${esc(t)}</td>`;
          return i === 0 ? '<td class="total">total</td>' : '<td></td>';
        })
        .join('')}</tr></tfoot>`
    : '';
  return printDoc(
    d.title,
    opts,
    `${docHead(d.title, d.printDate)}${metaHtml(d.meta)}` +
      `<table class="csv"><thead>${head}</thead><tbody>${body}</tbody>${foot}</table>`,
  );
}

// ---- print plumbing (DOM) ---------------------------------------------------------------

/**
 * Write a full HTML document into a hidden same-origin iframe and open the
 * browser's native print dialog on it. The iframe stays in the DOM until the
 * print job is done (afterprint), then removes itself.
 */
export function printHtml(doc: string): void {
  const frame = h('iframe', { attrs: { title: 'Print view' } });
  Object.assign(frame.style, {
    position: 'fixed',
    right: '0',
    bottom: '0',
    width: '0',
    height: '0',
    border: '0',
    visibility: 'hidden',
  });
  document.body.appendChild(frame);
  const win = frame.contentWindow;
  const idoc = win?.document;
  if (!win || !idoc) {
    toast('Printing is not available in this browser', 'err');
    frame.remove();
    return;
  }
  idoc.open();
  idoc.write(doc);
  idoc.close();
  const go = () => {
    try {
      win.focus();
      win.print();
    } catch (e) {
      toast(`Printing failed: ${String(e)}`, 'err');
    }
  };
  // give the iframe document a moment to settle, then trigger the dialog
  if (idoc.readyState === 'complete') setTimeout(go, 120);
  else frame.onload = () => setTimeout(go, 120);
  win.addEventListener('afterprint', () => setTimeout(() => frame.remove(), 300));
  setTimeout(() => frame.remove(), 5 * 60_000); // safety net when afterprint never fires
}

/** Date picker for the top-right header date — clearing the input hides the date. */
export function printDateInput(): { el: HTMLElement; get: () => string | undefined } {
  const now = new Date();
  const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const inp = h('input', {
    class: cx(C.input, 'px-2 py-1'),
    attrs: { type: 'date' },
    title: 'date shown next to the document title (clear to hide)',
  }) as HTMLInputElement;
  inp.value = iso;
  return { el: inp, get: () => (inp.value ? dmy(inp.value) : undefined) };
}

// ---- shared font/size style ---------------------------------------------------------------

export interface PrintStyle {
  font: PrintFont;
  sizePt: number;
}

const STYLE_KEY = 'banking.printStyle';
const FONT_ORDER: PrintFont[] = ['mono', 'sans', 'serif'];
const FONT_LABELS: Array<[PrintFont, string]> = [['mono', 'Monospace'], ['sans', 'Sans-serif'], ['serif', 'Serif']];
const FONT_SIZES = [8, 9, 10, 11, 12];

export function loadPrintStyle(): PrintStyle {
  try {
    const raw = JSON.parse(localStorage.getItem(STYLE_KEY) ?? 'null') as Partial<PrintStyle> | null;
    if (raw && FONT_ORDER.includes(raw.font as PrintFont) && FONT_SIZES.includes(Number(raw.sizePt))) {
      return { font: raw.font as PrintFont, sizePt: Number(raw.sizePt) };
    }
  } catch { /* ignore */ }
  return { font: 'mono', sizePt: 10 };
}

export function savePrintStyle(s: PrintStyle): void {
  try {
    localStorage.setItem(STYLE_KEY, JSON.stringify(s));
  } catch { /* ignore */ }
}

/** Two selects (family + point size), pre-set from the shared style; `get()` reads them back. */
export function fontControls(): { el: HTMLElement; get: () => PrintStyle } {
  const cur = loadPrintStyle();
  const fam = h('select', { class: cx(C.input, 'px-2 py-1'), title: 'font family on paper' },
    ...FONT_LABELS.map(([v, l]) => h('option', { text: l, attrs: { value: v } })));
  fam.value = cur.font;
  const size = h('select', { class: cx(C.input, 'px-2 py-1'), title: 'font size (the rest of the document scales with it)' },
    ...FONT_SIZES.map((s) => h('option', { text: `${s} pt`, attrs: { value: String(s) } })));
  size.value = String(cur.sizePt);
  return {
    el: h('div', { class: 'flex items-center gap-1.5' }, fam, size),
    get: (): PrintStyle => ({ font: fam.value as PrintFont, sizePt: Number(size.value) }),
  };
}

// ---- active-tab print handler ------------------------------------------------------------

/**
 * The header's print button is generic: whichever tab is active registers the
 * function that opens its print dialog here (main.ts clears it before each
 * render, so tabs without printing — Settings — leave the button disabled).
 */
let tabPrintHandler: (() => void) | null = null;

export function setTabPrintHandler(fn: (() => void) | null): void {
  tabPrintHandler = fn;
}

export function hasTabPrintHandler(): boolean {
  return tabPrintHandler !== null;
}

export function triggerTabPrint(): void {
  tabPrintHandler?.();
}

// ---- option modal ------------------------------------------------------------------------

let overlay: HTMLElement | null = null;

function onEsc(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeModal();
}

function closeModal(): void {
  if (overlay) {
    overlay.remove();
    overlay = null;
  }
  document.removeEventListener('keydown', onEsc);
}

/** Checkbox as a pill label (matches the month-chip look). */
export function printCheck(
  label: string,
  checked: boolean,
  title?: string,
): { el: HTMLElement; cb: HTMLInputElement } {
  const cb = h('input', { attrs: { type: 'checkbox' } }) as HTMLInputElement;
  cb.checked = checked;
  const el = h('label', { class: cx(C.chipBase, C.chipSm, checked ? C.chipOn : C.chipNeutral), title: title ?? '' }, cb, label);
  return { el, cb };
}

/** Radio button as a pill label (same look, for either/or choices). */
export function printRadio(
  label: string,
  name: string,
  checked: boolean,
  title?: string,
): { el: HTMLElement; rb: HTMLInputElement } {
  const rb = h('input', { attrs: { type: 'radio', name } }) as HTMLInputElement;
  rb.checked = checked;
  const el = h('label', { class: cx(C.chipBase, C.chipSm, checked ? C.chipOn : C.chipNeutral), title: title ?? '' }, rb, label);
  return { el, rb };
}

/**
 * Options dialog shown before printing: `controls` carries the tab-specific
 * options; the Print button closes the modal and hands over. Same overlay
 * pattern as the upload dialog (Esc / backdrop close).
 */
export function openPrintModal(title: string, controls: HTMLElement, onPrint: () => void): void {
  closeModal();
  const card = h(
    'div',
    { class: 'max-h-[88vh] w-full max-w-[620px] overflow-y-auto border border-border bg-card p-4 shadow-card' },
    h('div', { class: 'mb-1 flex items-center gap-2' },
      h('h3', { class: 'flex items-center gap-2 text-[15px] font-semibold' }, title),
      h('button', { class: cx(C.btn, 'ml-auto px-2 py-1'), onclick: () => closeModal(), text: '✕', title: 'Close (Esc)' })),
    controls,
    h('div', { class: 'mt-4 flex flex-wrap items-center gap-2' },
      h('button', {
        class: C.btnPrimary,
        onclick: () => {
          closeModal();
          onPrint();
        },
      }, 'Print'),
      h('button', { class: cx(C.btn, 'ml-auto'), onclick: () => closeModal(), text: 'Cancel' })),
  );
  overlay = h('div', {
    class: 'fixed inset-0 z-[110] grid place-items-center bg-black/45 p-3 backdrop-blur-[2px]',
    onclick: (ev: MouseEvent) => {
      if (ev.target === overlay) closeModal();
    },
  }, card);
  document.body.appendChild(overlay);
  document.addEventListener('keydown', onEsc);
}
