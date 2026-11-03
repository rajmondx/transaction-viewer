import { SlidersHorizontal, CalendarDays, CalendarRange, Calculator, ChartColumn, ChartPie, ChevronDown, ChevronRight, ArrowLeftRight, Eye, Printer, ReceiptText, Tags, TrendingDown, TrendingUp, Type } from 'lucide';
import type { IconNode } from 'lucide';
import type { Agg, Month, Tx } from '../../types';
import { state, selectSettings, saveSpendingView, emit, type AvgMode } from '../../state';
import { aggregate, buildTree, flattenTree, matchTx, monthsFromTxs, UNCAT, type TreeNode } from '../../categories/engine';
import { C, clear, cx, dmy, field, h, money, monthLabel, monthKey, num0, num2, toast } from '../util';
import { attachCellSelect, clearColumnSelect } from '../cellSelect';
import { colResizeHandle } from '../colResize';
import { noCsvCard } from '../addCsv';
import { Ic } from '../icons';
import { shareBars, stackedBars, type ShareItem } from '../charts';
import { buildSpendingPrintDoc, fontControls, openPrintModal, printCheck, printDateInput, printHtml, savePrintStyle, setTabPrintHandler, type SpendingPrintData, type SpendingPrintRow } from '../print';

type Measure = 'expense' | 'income' | 'net';

/** cells clip instead of pushing the fixed-width column apart */
const SP_CELL = 'overflow-hidden text-ellipsis';

// ---- resizable columns (widths per column key: 'cat', 'total', 'avg' or a month) ----
const SP_COLW_KEY = 'banking.spendingColW';
const SP_MIN_W = 88;

function loadSpColW(): Record<string, number> {
  let saved: Record<string, unknown> = {};
  try {
    saved = JSON.parse(localStorage.getItem(SP_COLW_KEY) ?? '{}') as Record<string, unknown>;
  } catch { saved = {}; }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(saved)) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= SP_MIN_W) out[k] = n;
  }
  return out;
}

const spColW: Record<string, number> = loadSpColW();

function saveSpColW(): void {
  try {
    localStorage.setItem(SP_COLW_KEY, JSON.stringify(spColW));
  } catch { /* ignore */ }
}

// ---- print: remembered dialog options -------------------------------------------------
// Everything the user picks in the print dialog is stored, so the next print starts
// with the same layout (the CSV tab does the same for its own dialog).
interface SpendingPrintOpts {
  graphs: boolean;
  graphsNewPage: boolean;
  landscape: boolean;
  avgCol: boolean;
  avgOnly: boolean;
  /** the three footer rows ('Total Income' + 'Total Expenses' + 'Total Net' over the visible categories) under the table */
  totals: boolean;
  pageNums: boolean;
  /** the six summary blocks in print order: income, expenses, net, transactions, categorized, measure */
  summary: boolean[];
}
const PRINT_OPTS_KEY = 'banking.spendingPrintOpts';

function defaultPrintOpts(): SpendingPrintOpts {
  return {
    graphs: true,
    graphsNewPage: false,
    landscape: true,
    avgCol: false,
    avgOnly: false,
    totals: false,
    pageNums: true,
    summary: [false, false, false, false, false, false],
  };
}

function loadPrintOpts(): SpendingPrintOpts {
  const d = defaultPrintOpts();
  try {
    const raw = JSON.parse(localStorage.getItem(PRINT_OPTS_KEY) ?? 'null') as Partial<SpendingPrintOpts> | null;
    if (!raw || typeof raw !== 'object') return d;
    const flag = (v: unknown, fb: boolean): boolean => (typeof v === 'boolean' ? v : fb);
    const sum = Array.isArray(raw.summary) ? raw.summary : [];
    const only = flag(raw.avgOnly, d.avgOnly);
    return {
      graphs: flag(raw.graphs, d.graphs),
      graphsNewPage: flag(raw.graphsNewPage, d.graphsNewPage),
      landscape: flag(raw.landscape, d.landscape),
      // the two toggles are mutually exclusive; "Only Averages" wins if a stored file had both
      avgCol: only ? false : flag(raw.avgCol, d.avgCol),
      avgOnly: only,
      totals: flag(raw.totals, d.totals),
      pageNums: flag(raw.pageNums, d.pageNums),
      summary: d.summary.map((_, i) => sum[i] === true),
    };
  } catch { /* ignore */ }
  return d;
}

let printOpts = loadPrintOpts();

function savePrintOpts(o: SpendingPrintOpts): void {
  try {
    localStorage.setItem(PRINT_OPTS_KEY, JSON.stringify(o));
  } catch { /* ignore */ }
}

function measureOf(a: { debit: number; credit: number }, m: Measure): number {
  if (m === 'expense') return a.debit;
  if (m === 'income') return a.credit;
  return a.credit - a.debit;
}

function cellText(v: number, m: Measure): string {
  if (m === 'net') {
    if (v === 0) return '–';
    return `${v > 0 ? '+' : '−'}${num2(Math.abs(v))}`;
  }
  if (v === 0) return '·';
  return num2(v);
}

/** month-level subtree aggregation: for every tag, sum of own + descendants per month */
function subtreeByMonth(roots: TreeNode[], own: Map<string, Map<Month, Agg>>): Map<string, Map<Month, Agg>> {
  const out = new Map<string, Map<Month, Agg>>();
  const roll = (n: TreeNode): Map<Month, Agg> => {
    const acc = new Map<Month, Agg>();
    const add = (mo: Month, a: Agg) => {
      const cur = acc.get(mo) ?? { debit: 0, credit: 0, count: 0 };
      cur.debit += a.debit;
      cur.credit += a.credit;
      cur.count += a.count;
      acc.set(mo, cur);
    };
    for (const ch of n.children) for (const [mo, a] of roll(ch)) add(mo, a);
    for (const [mo, a] of own.get(n.tag) ?? []) add(mo, a);
    out.set(n.tag, acc);
    return acc;
  };
  roots.forEach(roll);
  return out;
}

export function renderSpending(container: HTMLElement): void {
  clearColumnSelect(); // a leftover marked column from the CSV page must not linger
  clear(container);
  // without a stored CSV there is nothing to aggregate — point at the upload instead
  if (state.files.length === 0) {
    container.appendChild(noCsvCard('No CSV loaded yet — this page needs at least one statement.'));
    return;
  }
  const settings = state.settings;
  const view = state.spendingView;

  const txsInRange = state.txs.filter((t) => {
    const d = t.bookingDate || t.valueDate;
    if (view.dateFrom && d < view.dateFrom) return false;
    if (view.dateTo && d > view.dateTo) return false;
    return true;
  });

  const agg = aggregate(txsInRange, settings);
  const allMonths = agg.months.length > 0 ? agg.months : monthsFromTxs(state.txs);
  const visibleMonths = allMonths.filter((m) => !view.hiddenMonths.includes(m));
  const roots = buildTree(settings);
  const flat = flattenTree(roots);
  const isHidden = (tag: string) => view.hiddenCats.includes(tag);
  const sub = subtreeByMonth(roots, agg.own);
  const measure = view.measure;
  const measureName = measure === 'expense' ? 'Expenses' : measure === 'income' ? 'Income' : 'Net';
  // average mode (sanitized: anything unexpected behaves as 'off')
  const avgMode: AvgMode = view.avgMode === 'column' || view.avgMode === 'only' ? view.avgMode : 'off';
  const showAvg = avgMode !== 'off';
  const monthCols = avgMode === 'only' ? [] : visibleMonths;
  /** Average = row Total ÷ number of visible (selected) months, zero months included */
  const averageOf = (total: number): number => (visibleMonths.length > 0 ? total / visibleMonths.length : 0);

  // ---- summary (always at top, reflects the current view) ----
  let sDebit = 0, sCredit = 0, sCount = 0, catDebit = 0;
  for (const [tag, byMonth] of agg.own) {
    if (isHidden(tag)) continue;
    for (const mo of visibleMonths) {
      const a = byMonth.get(mo);
      if (!a) continue;
      sDebit += a.debit; sCredit += a.credit; sCount += a.count;
      if (tag !== UNCAT) catDebit += a.debit;
    }
  }
  const coverage = sDebit > 0 ? (catDebit / sDebit) * 100 : 0;

  // ---- footer sums: per-month debit/credit over the visible categories only.
  // Taken from `own` (direct matches), so a child and its parent never count twice.
  const footMonth = new Map<Month, Agg>();
  for (const [tag, byMonth] of agg.own) {
    if (isHidden(tag)) continue;
    for (const [mo, a] of byMonth) {
      if (!visibleMonths.includes(mo)) continue;
      const cur = footMonth.get(mo) ?? { debit: 0, credit: 0, count: 0 };
      cur.debit += a.debit; cur.credit += a.credit; cur.count += a.count;
      footMonth.set(mo, cur);
    }
  }
  const footOf = (mo: Month): Agg => footMonth.get(mo) ?? { debit: 0, credit: 0, count: 0 };
  /** overall = exactly the summary sums above (same categories, same months) */
  const footTot: Agg = { debit: sDebit, credit: sCredit, count: sCount };
  const netOf = (a: Agg): number => a.credit - a.debit;

  // ---- toolbar ----
  const settingsSel = h('select', { class: C.input },
    ...state.settingsFiles.map((f) =>
      h('option', { text: f.name + (f.isDefault ? '  (default)' : ''), attrs: { value: f.name } }),
    ),
  ) as HTMLSelectElement;
  settingsSel.value = state.activeSettingsName;
  settingsSel.onchange = () => void selectSettings(settingsSel.value);

  const fromInput = h('input', { class: C.input, attrs: { type: 'date', value: view.dateFrom, 'aria-label': 'from' } }) as HTMLInputElement;
  const toInput = h('input', { class: C.input, attrs: { type: 'date', value: view.dateTo, 'aria-label': 'to' } }) as HTMLInputElement;
  const applyRange = () => {
    view.dateFrom = fromInput.value;
    view.dateTo = toInput.value;
    persist(); emit();
  };
  fromInput.onchange = applyRange;
  toInput.onchange = applyRange;

  const measureBtns = (['expense', 'income', 'net'] as Measure[]).map((m) =>
    h('button', {
      dataset: { fk: `smeas-${m}` },
      class: cx(C.togBase, 'px-2.5 py-1 font-sans', measure === m ? C.togOn : C.togOff),
      text: m === 'expense' ? 'Expenses' : m === 'income' ? 'Income' : 'Net',
      onclick: () => { view.measure = m; persist(); emit(); },
    }),
  );

  // ---- month toggles ----
  const monthChips = allMonths.map((mo) => {
    const on = !view.hiddenMonths.includes(mo);
    const cbEl = h('input', { dataset: { fk: `smo-${mo}` }, attrs: { type: 'checkbox', checked: on ? 'checked' : null } }) as HTMLInputElement;
    cbEl.checked = on;
    cbEl.onchange = () => {
      view.hiddenMonths = cbEl.checked ? view.hiddenMonths.filter((x) => x !== mo) : [...view.hiddenMonths, mo];
      persist(); emit();
    };
    return h('label', { class: cx(C.chipBase, C.chipSm, on ? C.chipOn : C.chipOff) }, cbEl, monthLabel(mo));
  });

  // ---- filter toolbar: labeled groups, months spanning the full width ----
  settingsSel.title = 'category settings used to classify the transactions';
  const monthsField = field('Months', CalendarDays,
    ...monthChips,
    h('button', { dataset: { fk: 'smo-all' }, class: C.link, text: 'all', onclick: () => { view.hiddenMonths = []; persist(); emit(); } }),
    h('button', { dataset: { fk: 'smo-none' }, class: C.link, text: 'none', onclick: () => { view.hiddenMonths = [...allMonths]; persist(); emit(); } }),
  );
  monthsField.classList.add('col-span-full');
  const dateField = field('Date range', CalendarRange, fromInput, '→', toInput,
    h('button', { class: C.link, text: 'clear', onclick: () => { fromInput.value = ''; toInput.value = ''; applyRange(); } }));
  dateField.classList.add('col-span-2');
  const showField = field('Show', Eye, ...measureBtns);
  showField.classList.add('col-span-2');
  // ---- average mode: two mutually-exclusive toggles, own row below the months ----
  const avgBtn = (mode: AvgMode, label: string, title: string): HTMLElement =>
    h('button', {
      dataset: { fk: `savg-${mode}` },
      class: cx(C.togBase, 'px-2.5 py-1 font-sans', avgMode === mode ? C.togOn : C.togOff),
      text: label,
      title,
      onclick: () => { view.avgMode = avgMode === mode ? 'off' : mode; persist(); emit(); },
    });
  const averageField = field('Average', Calculator,
    avgBtn('column', 'Average Column', 'adds an Average column next to Total (row Total ÷ the selected months); clicking it again turns it off'),
    avgBtn('only', 'Only Averages', 'hides the month columns — shows Category with Total and Average only; clicking it again turns it off'),
  );
  averageField.classList.add('col-span-full');
  container.appendChild(
    h('div', { class: cx(C.card, 'mb-3 grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] items-start gap-x-5 gap-y-3.5 px-3.5 py-3') },
      field('Filter', SlidersHorizontal, settingsSel),
      dateField,
      showField,
      monthsField,
      averageField,
    ),
  );

  // ---- matrix ----
  // columns are resizable (drag the right edge of a header, double-click the handle
  // for the automatic width); widths live in localStorage under banking.spendingColW
  const expanded = new Set<string>();
  const table = h('table', { class: 'w-full border-collapse text-[13px]', style: { tableLayout: 'fixed' } });
  const colgroup = h('colgroup');
  table.appendChild(colgroup);
  const colEntries: Array<{ key: string; def: number | null }> = [];

  /** never let the table collapse below what its fixed-width columns need */
  const syncMinW = (): void => {
    let px = 0;
    for (const e of colEntries) {
      const w = spColW[e.key] ?? e.def;
      px += w ?? SP_MIN_W;
    }
    table.style.minWidth = `${px}px`;
  };

  /** register one <col> plus its resize handle */
  const addCol = (key: string, th: HTMLElement, def: number | null): void => {
    colEntries.push({ key, def });
    const col = h('col');
    const start = spColW[key] ?? def;
    if (start) col.style.width = `${start}px`;
    colgroup.appendChild(col);
    th.appendChild(colResizeHandle({
      width: () => {
        const w = spColW[key] ?? def;
        if (w) return w;
        const measured = Math.round(th.getBoundingClientRect().width);
        return measured > 0 ? measured : SP_MIN_W;
      },
      apply: (px) => {
        if (px === 0) delete spColW[key];
        else spColW[key] = px;
        const now = spColW[key] ?? def;
        col.style.width = now ? `${now}px` : '';
        syncMinW();
      },
      commit: () => saveSpColW(),
      min: SP_MIN_W,
    }));
  };

  const thead = h('thead');
  const hrow = h('tr');
  const catTh = h('th', { class: cx('sticky left-0 z-6 relative', C.th), text: 'Category' });
  hrow.appendChild(catTh);
  addCol('cat', catTh, 260);
  for (const mo of monthCols) {
    const colCb = h('input', { dataset: { fk: `smocol-${mo}` }, attrs: { type: 'checkbox', checked: 'checked', title: 'hide this month' } }) as HTMLInputElement;
    colCb.onchange = () => {
      view.hiddenMonths = [...view.hiddenMonths, mo]; persist(); emit();
    };
    const th = h('th', { class: cx(C.th, 'relative text-right') },
      h('div', { class: 'flex items-end justify-end gap-1.5' }, colCb, h('span', { text: monthLabel(mo) })));
    hrow.appendChild(th);
    addCol(mo, th, null);
  }
  // Average first, Total last — the total is the number you read at the end of a row
  if (showAvg) {
    const avgTh = h('th', {
      class: cx(C.th, C.num, 'relative'),
      text: 'Average',
      title: `Total ÷ ${visibleMonths.length} selected month${visibleMonths.length === 1 ? '' : 's'} (months without spending count as 0)`,
    });
    hrow.appendChild(avgTh);
    addCol('avg', avgTh, 120);
  }
  const totTh = h('th', { class: cx(C.th, C.num, 'relative'), text: 'Total' });
  hrow.appendChild(totTh);
  addCol('total', totTh, 120);
  thead.appendChild(hrow);
  table.appendChild(thead);

  const tbody = h('tbody');
  for (const [ri, node] of flat.entries()) {
    const tag = node.tag;
    const hidden = isHidden(tag);
    const isUncat = tag === UNCAT;
    const cat = node.category;
    const hasDateRange = cat && (cat.dateFrom || cat.dateTo);
    // zebra striping; the sticky name cell repeats the row tint (it must stay opaque while scrolling)
    const stripe = ri % 2 === 1 ? 'bg-zebra' : 'bg-card';
    const tr = h('tr', { class: cx('group hover:bg-muted/40', stripe, hidden && 'opacity-40', node.depth > 0 ? '' : 'font-semibold') });

    // checkbox + name cell (data-fk keeps the focus on it across the re-render)
    const cb = h('input', { dataset: { fk: `scat-${ri}` }, attrs: { type: 'checkbox', checked: hidden ? null : 'checked' } }) as HTMLInputElement;
    cb.onchange = () => {
      view.hiddenCats = cb.checked ? view.hiddenCats.filter((x) => x !== tag) : [...view.hiddenCats, tag];
      persist(); emit();
    };
    const dot = h('span', { class: C.dot, style: { background: isUncat ? '#9aa2ad' : cat!.color } });
    const toggle = h('a', { class: 'inline-flex w-3.5 shrink-0 cursor-pointer items-center text-muted-foreground select-none', onclick: (e: MouseEvent) => { e.stopPropagation(); toggleDetails(tag); } },
      Ic(expanded.has(tag) ? ChevronDown : ChevronRight, 'size-3.5'));
    const nameLabel = h('span', { class: 'min-w-0 flex-1 truncate', text: tag, title: tag });
    if (cat && cat.rules.length > 0) nameLabel.title = `rules: ${cat.rules.map((r) => (r.regex ? `/${r.text}/` : r.text) + (r.fuzzy ? '~' : '') + (r.caseSensitive ? ' (case)' : '')).join(', ')}`;
    const badge = hasDateRange
      ? h('span', { class: 'border border-warning/30 bg-warning/10 px-1.5 py-px text-[10px] text-warning', title: 'category date range', text: `${cat!.dateFrom ? dmy(cat!.dateFrom) : '…'}–${cat!.dateTo ? dmy(cat!.dateTo) : '…'}` })
      : null;
    const offBadge = !cat?.enabled && !isUncat ? h('span', { class: C.badgeMuted, text: 'disabled' }) : null;
    const nameCell = h('td', { class: cx('sticky left-0 z-3 flex items-center gap-2 overflow-hidden border-b border-border px-2.5 py-2 whitespace-nowrap group-hover:bg-muted/40', stripe) },
      toggle, cb, dot, nameLabel, badge, offBadge);
    nameCell.style.paddingLeft = `${10 + node.depth * 22}px`;
    tr.appendChild(nameCell);

    const monthVals = sub.get(tag) ?? new Map();
    for (const mo of monthCols) {
      const a = monthVals.get(mo) ?? { debit: 0, credit: 0, count: 0 };
      const v = measureOf(a, measure);
      tr.appendChild(h('td', { class: cx(C.td, C.num, SP_CELL, v < 0 && 'text-danger', a.count === 0 && 'text-muted-foreground/40'), text: cellText(v, measure) }));
    }
    const tot = measureOf(subtreeTotals(sub.get(tag)), measure);
    if (showAvg) {
      const avg = averageOf(tot);
      tr.appendChild(h('td', { class: cx(C.td, C.num, SP_CELL, 'bg-subtle/40', avg < 0 && 'text-danger'), text: cellText(avg, measure) }));
    }
    tr.appendChild(h('td', { class: cx(C.td, C.num, SP_CELL, 'bg-subtle/60 font-semibold', tot < 0 && 'text-danger'), text: cellText(tot, measure) }));
    tbody.appendChild(tr);

    // detail placeholder row (filled on demand)
    const detRow = h('tr', { class: 'detail-row', dataset: { det: tag }, attrs: { hidden: 'hidden' } });
    detRow.appendChild(h('td', { class: 'bg-subtle p-0', attrs: { colspan: String(monthCols.length + 2 + (showAvg ? 1 : 0)) } }));
    tbody.appendChild(detRow);
  }

  // ---- footer: 'Total Income' + 'Total Expenses' + 'Total Net' rows. Each carries a
  // thicker top line (same weight as the header rule) so the block reads as table sums,
  // clearly apart from the category rows; the values ignore the shown measure.
  const footRow = (label: string, title: string, fmt: Measure, of: (a: Agg) => number): void => {
    const tr = h('tr', { class: 'bg-card font-semibold', title });
    tr.appendChild(h('td', {
      class: cx('sticky left-0 z-3 flex items-center border-b border-border border-t-2 bg-subtle px-2.5 py-2 whitespace-nowrap', SP_CELL),
      text: label,
    }));
    const numCell = (v: number, tint: string | false): void => {
      tr.appendChild(h('td', { class: cx(C.td, C.num, SP_CELL, 'border-t-2', tint, v < 0 && 'text-danger'), text: cellText(v, fmt) }));
    };
    for (const mo of monthCols) numCell(of(footOf(mo)), false);
    if (showAvg) numCell(averageOf(of(footTot)), 'bg-subtle/40');
    numCell(of(footTot), 'bg-subtle/60');
    tbody.appendChild(tr);
  };
  footRow('Total Income', 'sum of all income (credits) over the visible categories — not a category row', 'income', (a) => a.credit);
  footRow('Total Expenses', 'sum of all expenses (debits) over the visible categories — not a category row', 'expense', (a) => a.debit);
  footRow('Total Net', 'income − expenses over the visible categories — not a category row', 'net', netOf);

  table.appendChild(tbody);
  syncMinW();
  container.appendChild(h('div', { class: C.scroll }, table));
  attachCellSelect(tbody); // one click picks the cell's own text — no column marking here

  function toggleDetails(tag: string): void {
    if (expanded.has(tag)) {
      expanded.delete(tag);
      (document.querySelector(`[data-det="${cssEsc(tag)}"]`) as HTMLElement | null)?.setAttribute('hidden', 'hidden');
      return;
    }
    expanded.add(tag);
    const detRow = tbody.querySelector(`[data-det="${cssEsc(tag)}"]`) as HTMLElement | null;
    if (!detRow) return;
    detRow.removeAttribute('hidden');
    const cell = detRow.firstElementChild as HTMLElement;
    clear(cell);
    const txs = (agg.txByTag.get(tag) ?? []).filter((t) => {
      const mo = monthKey(t.bookingDate || t.valueDate);
      return visibleMonths.includes(mo);
    });
    const tree = buildTree(state.settings);
    const node = flattenTree(tree).find((n) => n.tag === tag);
    const inSubtree = new Set<string>();
    const collect = (n: TreeNode) => { inSubtree.add(n.tag); n.children.forEach(collect); };
    if (node) collect(node);
    // respect hidden months in the subtree list too (Uncategorized renders from this)
    const visibleInRange = txsInRange.filter((t) => visibleMonths.includes(monthKey(t.bookingDate || t.valueDate)));
    const subtreeTxs = visibleInRange.filter((t) => inSubtree.has(matchTx(t, state.settings)));
    cell.appendChild(h('div', { class: 'flex items-baseline gap-3.5 px-3.5 pt-2.5 pb-1' },
      h('b', { text: `${tag} — ${txs.length} transactions` }),
      h('span', { class: C.muted, text: `directly matched (own rules); total incl. subcategories: ${subtreeTxs.length}` }),
    ));
    renderTxsInto(cell, tag === UNCAT ? subtreeTxs : txs, visibleMonths);
  }

  function subtreeTotals(m: Map<Month, Agg> | undefined): Agg {
    let dd = 0, cc = 0, kk = 0;
    if (m) for (const [mo, a] of m) {
      if (!visibleMonths.includes(mo)) continue;
      dd += a.debit; cc += a.credit; kk += a.count;
    }
    return { debit: dd, credit: cc, count: kk };
  }

  // ---- charts ----
  // one card under the other: the monthly chart is as wide as its month count
  // needs (and scrolls inside its own card), so it can never push the Share
  // chart out of the window the way the old side-by-side grid did
  const rootVisible = roots.filter((r) => !isHidden(r.tag));
  const series = rootVisible.map((r) => ({
    name: r.tag,
    color: r.category?.color ?? '#9aa2ad',
    values: visibleMonths.map((mo) => {
      const a = (sub.get(r.tag) ?? new Map()).get(mo) ?? { debit: 0, credit: 0, count: 0 };
      return measureOf(a, measure);
    }),
  }));
  // measureName (defined with the measure) labels the chart cards

  /** Share chart: the 12 biggest top-level categories, each optionally followed by its
   *  own sub-categories, grouped under it. Percentages stay relative to the top-level
   *  magnitudes, so a parent and its children never count twice. */
  const shareSubs = view.shareSubs === true;
  const valueOf = (n: TreeNode): number => measureOf(subtreeTotals(sub.get(n.tag)), measure);
  const byMagnitude = (a: TreeNode, b: TreeNode): number => Math.abs(valueOf(b)) - Math.abs(valueOf(a));
  const shareTotal = rootVisible.reduce((s, r) => s + valueOf(r), 0);
  const shareDenominator = rootVisible.reduce((s, r) => s + Math.abs(valueOf(r)), 0);
  const shareItems: ShareItem[] = [];
  for (const r of [...rootVisible].sort(byMagnitude).slice(0, 12)) {
    shareItems.push({ name: r.tag, color: r.category?.color ?? '#9aa2ad', value: valueOf(r), depth: 0 });
    if (!shareSubs) continue;
    for (const ch of [...r.children].sort(byMagnitude)) {
      if (isHidden(ch.tag)) continue;
      shareItems.push({ name: ch.tag, color: ch.category?.color ?? '#9aa2ad', value: valueOf(ch), depth: 1 });
    }
  }
  const subsCb = h('input', { dataset: { fk: 'sshare-subs' }, attrs: { type: 'checkbox' } }) as HTMLInputElement;
  subsCb.checked = shareSubs;
  subsCb.onchange = () => { view.shareSubs = subsCb.checked; persist(); emit(); };
  const subsChip = h('label', {
    class: cx(C.chipBase, C.chipSm, shareSubs ? C.chipOn : C.chipNeutral),
    title: 'show every sub-category in a block right below its top-level category',
  }, subsCb, 'Sub-categories');

  container.appendChild(h('div', { class: 'mt-3.5 grid gap-3' },
    h('div', { class: cx(C.card, 'min-w-0 px-4 py-3') },
      h('h3', { class: 'mb-2 flex items-center gap-1.5 text-[13px] text-muted-foreground' }, Ic(ChartColumn, 'size-4'), `Monthly — ${measureName}`),
      series.length ? stackedBars(visibleMonths.map(monthLabel), series) : h('div', { class: C.muted, text: 'no data' })),
    h('div', { class: cx(C.card, 'min-w-0 px-4 py-3') },
      h('h3', { class: 'mb-2 flex items-center gap-1.5 text-[13px] text-muted-foreground' },
        Ic(ChartPie, 'size-4'), 'Share',
        h('span', { class: 'flex-1' }),
        subsChip),
      shareBars(shareItems, measureName, { total: shareTotal, denominator: shareDenominator }))));

  // ---- footer: dashboard summary (about/contact lives in the global app footer — see main.ts) ----
  container.appendChild(
    h('div', { class: 'mt-4 grid gap-2.5 grid-cols-[repeat(auto-fit,minmax(140px,1fr))]' },
      summaryCard('Income', money(sCredit), 'text-success', TrendingUp),
      summaryCard('Expenses', money(sDebit), 'text-danger', TrendingDown),
      summaryCard('Net', money(sCredit - sDebit), sCredit - sDebit >= 0 ? 'text-success' : 'text-danger', ArrowLeftRight),
      summaryCard('Transactions', String(sCount), '', ReceiptText),
      summaryCard('Categorized', `${coverage.toFixed(1)} %`, '', Tags),
    ),
  );

  // ---- print ----

  /** Snapshot the current view as plain data for the printable document builder. */
  function printData(printDate: string | undefined, summary: Array<{ label: string; value: string }>, withFooter: boolean): SpendingPrintData {
    const rows = flat
      .filter((node) => !isHidden(node.tag))
      .map((node) => {
        const monthVals = sub.get(node.tag) ?? new Map<Month, Agg>();
        const tot = measureOf(subtreeTotals(monthVals), measure);
        return {
          name: node.tag,
          depth: node.depth,
          cells: visibleMonths.map((mo) => {
            const a = monthVals.get(mo) ?? { debit: 0, credit: 0, count: 0 };
            return cellText(measureOf(a, measure), measure);
          }),
          total: cellText(tot, measure),
          avg: cellText(averageOf(tot), measure),
        };
      });
    // the printed share table stays top-level (shareBarsPrint ranks and caps it itself)
    const months = visibleMonths.map(monthLabel);
    // 'Total Income' + 'Total Expenses' + 'Total Net' footer rows — the same sums the screen shows under the matrix
    const footer: SpendingPrintRow[] | undefined = withFooter
      ? [
          {
            name: 'Total Income',
            depth: 0,
            cells: visibleMonths.map((mo) => cellText(footOf(mo).credit, 'income')),
            total: cellText(footTot.credit, 'income'),
            avg: cellText(averageOf(footTot.credit), 'income'),
          },
          {
            name: 'Total Expenses',
            depth: 0,
            cells: visibleMonths.map((mo) => cellText(footOf(mo).debit, 'expense')),
            total: cellText(footTot.debit, 'expense'),
            avg: cellText(averageOf(footTot.debit), 'expense'),
          },
          {
            name: 'Total Net',
            depth: 0,
            cells: visibleMonths.map((mo) => cellText(netOf(footOf(mo)), 'net')),
            total: cellText(netOf(footTot), 'net'),
            avg: cellText(averageOf(netOf(footTot)), 'net'),
          },
        ]
      : undefined;
    return {
      title: 'Spending',
      meta: [],
      printDate,
      summary,
      measureName,
      months,
      rows,
      footer,
      stacked: { months, series },
      share: {
        totalLabel: measureName,
        sumLabel: `CHF ${num2(shareTotal)}`,
        items: rootVisible.map((r) => ({ name: r.tag, value: valueOf(r), amount: num2(valueOf(r)) })),
      },
    };
  }

  function openPrintDialog(): void {
    if (visibleMonths.length === 0 || sCount === 0) {
      toast('Nothing to print', 'err');
      return;
    }
    const graphs = printCheck('Include graphs', printOpts.graphs, 'monthly bars + share bars, drawn monochrome (hatched SVG / text bars)');
    const graphsNewPage = printCheck('New line for graphs', printOpts.graphsNewPage, 'start the “Monthly — …” chart section on a new page; off = right after the table');
    const landscape = printCheck('Landscape', printOpts.landscape, 'wide tables fit better on landscape pages');
    // the two average toggles are mutually exclusive: each turns the other off
    const avgCol = printCheck('Add Average Column', printOpts.avgCol, 'extra column next to Total: row Total ÷ the months shown on screen');
    const avgOnly = printCheck('Only Averages', printOpts.avgOnly, 'leave out the month columns — print Category, Total and Average only');
    const chipPaint = (c: { el: HTMLElement; cb: HTMLInputElement }): void => {
      c.el.className = cx(C.chipBase, C.chipSm, c.cb.checked ? C.chipOn : C.chipNeutral);
    };
    avgCol.cb.onchange = () => { if (avgCol.cb.checked) { avgOnly.cb.checked = false; chipPaint(avgOnly); } chipPaint(avgCol); };
    avgOnly.cb.onchange = () => { if (avgOnly.cb.checked) { avgCol.cb.checked = false; chipPaint(avgCol); } chipPaint(avgOnly); };
    const totalsRow = printCheck('Show totals row', printOpts.totals, 'the “Total Income”, “Total Expenses” and “Total Net” footer rows under the table — sums over the visible categories');
    const pageNums = printCheck('Show page numbers', printOpts.pageNums, '“n / total” centered at the bottom of each page');
    const date = printDateInput();
    const font = fontControls();
    // 'New line for graphs' only means something while graphs are included
    const syncGraphs = (): void => {
      const on = graphs.cb.checked;
      graphsNewPage.cb.disabled = !on;
      graphsNewPage.el.classList.toggle('opacity-50', !on);
    };
    graphs.cb.onchange = syncGraphs;
    syncGraphs();
    // one chip per summary block, in print order — off by default, each remembered per print
    const sumChecks = [
      printCheck('Income', printOpts.summary[0]),
      printCheck('Expenses', printOpts.summary[1]),
      printCheck('Net', printOpts.summary[2]),
      printCheck('Transactions', printOpts.summary[3]),
      printCheck('Categorized', printOpts.summary[4]),
      printCheck('Measure', printOpts.summary[5], 'which measure (Expenses / Income / Net) the table numbers show'),
    ];
    const controls = h('div', { class: 'flex flex-col gap-2.5' },
      field('Content', ChartColumn, graphs.el, graphsNewPage.el, landscape.el, avgCol.el, avgOnly.el, totalsRow.el),
      field('Summary', ReceiptText, ...sumChecks.map((c) => c.el)),
      field('Page', Printer, pageNums.el, date.el),
      field('Font', Type, font.el),
      h('p', { class: cx(C.muted, 'text-[12.5px]') },
        'Printer-friendly output on white: black ink only; hidden categories and months are left out.'));
    openPrintModal('Print spending table', controls, () => {
      const allSummary = [
        { label: 'Income', value: money(sCredit) },
        { label: 'Expenses', value: money(sDebit) },
        { label: 'Net', value: money(sCredit - sDebit) },
        { label: 'Transactions', value: num0(sCount) },
        { label: 'Categorized', value: `${coverage.toFixed(1)} %` },
        { label: 'Measure', value: measureName },
      ];
      const style = font.get();
      savePrintStyle(style);
      printOpts = {
        graphs: graphs.cb.checked,
        graphsNewPage: graphsNewPage.cb.checked,
        landscape: landscape.cb.checked,
        avgCol: avgCol.cb.checked,
        avgOnly: avgOnly.cb.checked,
        totals: totalsRow.cb.checked,
        pageNums: pageNums.cb.checked,
        summary: sumChecks.map((c) => c.cb.checked),
      };
      savePrintOpts(printOpts);
      printHtml(buildSpendingPrintDoc(printData(date.get(), allSummary.filter((_, i) => sumChecks[i].cb.checked), totalsRow.cb.checked), {
        graphs: graphs.cb.checked,
        graphsNewPage: graphsNewPage.cb.checked,
        landscape: landscape.cb.checked,
        average: avgCol.cb.checked,
        onlyAverages: avgOnly.cb.checked,
        pageNumbers: pageNums.cb.checked,
        font: style.font,
        sizePt: style.sizePt,
      }));
    });
  }

  // the header print button opens this dialog while this tab is active
  setTabPrintHandler(() => openPrintDialog());

  function persist(): void {
    saveSpendingView(state.activeSettingsName, state.spendingView);
  }
}

function summaryCard(label: string, value: string, tone: string, icon: IconNode): HTMLElement {
  return h('div', { class: cx(C.card, 'px-3.5 py-2.5') },
    h('div', { class: cx(C.label, 'flex items-center gap-1.5') }, Ic(icon, 'size-3.5'), label),
    h('div', { class: cx('mt-0.5 text-[19px] font-bold', tone), text: value }));
}

function cssEsc(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}

/** compact transaction list used inside detail expansions — zebra-striped like the tables */
function renderTxsInto(el: HTMLElement, txs: Tx[], _mo: Month[]): void {
  const list = h('div', { class: 'px-1.5 pt-1 pb-3' });
  const shown = txs.slice(0, 150);
  for (const [ri, t] of shown.entries()) {
    list.appendChild(h('div', {
      class: cx(
        'grid grid-cols-[84px_1fr_96px] gap-2.5 border-b border-border/60 px-2 py-[3px] text-[12.5px]',
        ri % 2 === 0 ? 'bg-card' : 'bg-transparent',
      ),
    },
      h('span', { class: 'font-mono text-muted-foreground', text: dmy(t.bookingDate) }),
      h('span', { class: 'truncate', text: t.text }),
      h('span', { class: cx('text-right tabular-nums', t.credit > 0 ? 'text-success' : 'text-danger'), text: t.credit > 0 ? `+${num2(t.credit)}` : `−${num2(t.debit)}` }),
    ));
  }
  if (txs.length > shown.length) list.appendChild(h('div', { class: cx(C.muted, 'px-2 pt-1'), text: `… ${txs.length - shown.length} more` }));
  el.appendChild(list);
}
