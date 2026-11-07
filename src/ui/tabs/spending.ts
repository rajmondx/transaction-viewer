import { SlidersHorizontal, CalendarDays, CalendarRange, Calculator, ChartColumn, ChartPie, ChevronDown, ChevronRight, ArrowLeft, ArrowLeftRight, Banknote, Eye, Pin, Printer, ReceiptText, Tags, TrendingDown, TrendingUp, Type } from 'lucide';
import type { IconNode } from 'lucide';
import type { Agg, Month, Tx } from '../../types';
import { cashEntryTx, cashOpeningBalance, isUncountedCashTransfer, uniqueReconciliationCategory } from '../../cash';
import { buildBalanceOverview } from '../../balanceOverview';
import { state, selectSettings, saveSpendingView, emit, type AvgMode } from '../../state';
import { aggregate, buildTree, flattenTree, matchTx, monthsFromTxs, UNCAT, type TreeNode } from '../../categories/engine';
import { C, clear, cx, dmy, field, h, money, monthLabel, monthKey, num0, num2, sourceGroup, toast } from '../util';
import { attachCellSelect, clearColumnSelect } from '../cellSelect';
import { attachDragPan } from '../dragScroll';
import { colResizeHandle } from '../colResize';
import { noCsvCard } from '../addCsv';
import { Ic } from '../icons';
import { shareBars, stackedBars, type ShareItem } from '../charts';
import { downloadCsv, exportAmount, fileStamp, setTabExportHandler } from '../exportCsv';
import { buildSpendingPrintDoc, fontControls, openPrintModal, printCheck, printDateInput, printHtml, savePrintStyle, setTabPrintHandler, type SpendingPrintData, type SpendingPrintRow } from '../print';

type Measure = 'expense' | 'income' | 'net';

/** cells clip instead of pushing the fixed-width column apart */
const SP_CELL = 'overflow-hidden text-ellipsis';

// ---- month drill-down (Monthly chart) ----
// which month's single-month view the chart card currently shows (null = the
// normal Monthly chart). Session-local on purpose: a fresh page load starts on
// the Monthly chart, and 'Return' clears it again.
let monthFocus: Month | null = null;

// ---- resizable columns (widths per column key: 'cat', 'total', 'avg' or a month) ----
const SP_COLW_KEY = 'banking.spendingColW';
const SP_MIN_W = 88;

// ---- static-column pinning ----
// each static column (Category / Average / Total) is pinned on its own; a column
// without an explicit choice follows the viewport: pinned from the app's `wide`
// breakpoint up, free on tablet/mobile. Clicking a static header stores its choice.
const PIN_BREAKPOINT = 1041;
const autoPin = (): boolean => window.innerWidth >= PIN_BREAKPOINT;
let pinResizeWired = false;
/** while any column is still in auto mode, re-evaluate it when the window crosses
 *  the breakpoint (columns with an explicit click-stored choice are left alone) */
function wirePinAutoResize(): void {
  if (pinResizeWired) return;
  pinResizeWired = true;
  let last = autoPin();
  let timer: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (state.activeTab !== 'spending') return;
      const p = state.spendingView.pinStatic ?? {};
      if (p.cat !== undefined && p.avg !== undefined && p.total !== undefined) return; // all explicit
      const now = autoPin();
      if (now !== last) { last = now; emit(); }
    }, 150);
  });
}

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
  if (state.files.length === 0 && state.cashEntries.length === 0) {
    container.appendChild(noCsvCard('No CSV loaded yet — this page needs at least one statement.'));
    return;
  }
  const settings = state.settings;
  const view = state.spendingView;
  const balanceOverview = buildBalanceOverview(state.txs, state.cashEntries, settings, cashOpeningBalance());

  const reconciliationCategory = uniqueReconciliationCategory(settings);
  const cashTxs = state.cashEntries.map((entry) => cashEntryTx(entry, reconciliationCategory));
  // Cash-movement bank rows are no longer dropped from the report input: they stay
  // visible in the table and the drill-down, but only count into the totals once the
  // user includes that category (clickable "Cash movement" badge on its row).
  const cashTags = new Set(settings.categories.filter((c) => c.cashMovement).map((c) => c.tag));
  const countedCash = new Set(view.cashInSpending.filter((t) => cashTags.has(t)));
  const txsInRangeAll = [...state.txs, ...cashTxs].filter((t) => {
    const d = t.bookingDate || t.valueDate;
    if (view.dateFrom && d < view.dateFrom) return false;
    if (view.dateTo && d > view.dateTo) return false;
    return true;
  });
  // Cash | Bank | All segment: 'cash' keeps the manually recorded entries only,
  // 'bank' the imported rows — manual cash entries are hidden. Uncounted cash
  // transfers stay out of the totals exactly as they do in the default view.
  const scopeRows = view.source === 'both'
    ? txsInRangeAll
    : txsInRangeAll.filter((t) => view.source === 'cash' ? Boolean(t.cashEntryId) : !t.cashEntryId);
  const txsInRange = scopeRows.filter((t) => !isUncountedCashTransfer(t, settings, countedCash));

  // This reserved category exists only in the report model; it is never written
  // into the user's category settings. It keeps corrections visible and
  // prevents them being rolled into ordinary Uncategorized transactions.
  const reportSettings = {
    ...settings,
    categories: [
      ...settings.categories,
      {
        tag: reconciliationCategory, tagFather: null, color: '#9aa2ad', ibans: [], rules: [],
        dateFrom: null, dateTo: null, enabled: true,
      },
    ],
  };
  const agg = aggregate(txsInRange, reportSettings);
  // Drill-down scope: everything in range, including cash-movement rows the totals
  // leave out — so expanding "Bargeld" still lists its 18 withdrawals. When the
  // Cash | Bank | All segment hides one source, the scope shrinks to the visible rows.
  const aggAll = view.source === 'both' ? aggregate(txsInRangeAll, reportSettings) : aggregate(scopeRows, reportSettings);
  const allMonths = aggAll.months.length > 0 ? aggAll.months : monthsFromTxs(scopeRows);
  const visibleMonths = allMonths.filter((m) => !view.hiddenMonths.includes(m));
  const roots = buildTree(reportSettings);
  const flat = flattenTree(roots);
  const isHidden = (tag: string) => view.hiddenCats.includes(tag);
  const sub = subtreeByMonth(roots, agg.own);
  // Keep dimmed matrix rows intact, but exclude their own transactions from
  // chart rollups just as the summary and footer do (children toggle separately).
  const chartSub = subtreeByMonth(roots, new Map([...agg.own].filter(([tag]) => !isHidden(tag))));
  const measure = view.measure;
  const measureName = measure === 'expense' ? 'Expenses' : measure === 'income' ? 'Income' : 'Net';
  // average mode (sanitized: anything unexpected behaves as 'off')
  const avgMode: AvgMode = view.avgMode === 'column' || view.avgMode === 'only' ? view.avgMode : 'off';
  const showAvg = avgMode !== 'off';
  const monthCols = avgMode === 'only' ? [] : visibleMonths;
  /** Average = row Total ÷ number of visible (selected) months, zero months included */
  const averageOf = (total: number): number => (visibleMonths.length > 0 ? total / visibleMonths.length : 0);

  const balanceCards = h('section', { class: 'mb-3' },
    h('h2', { class: 'mb-2 text-sm font-semibold' }, 'Balance summary'),
    h('div', { class: 'grid grid-cols-[repeat(auto-fit,minmax(165px,1fr))] gap-2' },
      summaryCard('Total balance', `${balanceOverview.unanchoredAccounts.length > 0 ? 'Δ ' : ''}${money(balanceOverview.combinedBalance)}`, balanceOverview.combinedBalance < 0 ? 'text-danger' : '', Banknote),
      summaryCard('Cash balance', money(balanceOverview.cashBalance), balanceOverview.cashBalance < 0 ? 'text-danger' : '', Banknote),
      summaryCard('Bank balance', `${balanceOverview.unanchoredAccounts.length > 0 ? 'Δ ' : ''}${money(balanceOverview.bankBalance)}`, balanceOverview.bankBalance < 0 ? 'text-danger' : '', ArrowLeftRight),
    ),
    h('div', { class: cx(C.card, 'mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3.5 py-2.5 text-xs') },
      balanceOverview.unanchoredAccounts.length > 0
        ? h('span', { class: C.muted }, `Δ is an estimate: accounts without opening balances use net movement from zero. Set opening balances in Transactions for actual bank and total balances. Missing anchors: ${balanceOverview.unanchoredAccounts.join(', ')}.`)
        : h('span', { class: C.muted, text: 'Opening balances, imported transactions, cash activity and reconciliation corrections are reflected here. Spending filters below affect only the report.' })));
  container.appendChild(balanceCards);

  // ---- summary (always at top, reflects the current view) ----
  let sDebit = 0, sCredit = 0, sCount = 0, catDebit = 0;
  for (const [tag, byMonth] of agg.own) {
    if (isHidden(tag)) continue;
    for (const mo of visibleMonths) {
      const a = byMonth.get(mo);
      if (!a) continue;
      sDebit += a.debit; sCredit += a.credit; sCount += a.count;
      if (tag !== UNCAT && tag !== reconciliationCategory) catDebit += a.debit;
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

  const sourceBtns = sourceGroup('ssrc', view.source, {
    cash: 'count only manually recorded cash entries; bank transactions and cash transfers are hidden',
    bank: 'count imported bank transactions only; manual cash entries are hidden',
    all: 'count everything (default); cash-transfer rows stay out of the totals until you include them',
  }, (v) => { view.source = v; persist(); emit(); });

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

  // ---- month toggles: grouped by year, one row per year ----
  const chipFor = (mo: Month): HTMLElement => {
    const on = !view.hiddenMonths.includes(mo);
    const cbEl = h('input', { dataset: { fk: `smo-${mo}` }, attrs: { type: 'checkbox', checked: on ? 'checked' : null } }) as HTMLInputElement;
    cbEl.checked = on;
    cbEl.onchange = () => {
      view.hiddenMonths = cbEl.checked ? view.hiddenMonths.filter((x) => x !== mo) : [...view.hiddenMonths, mo];
      persist(); emit();
    };
    // the year already labels the row — the chip only needs the month name
    return h('label', { class: cx(C.chipBase, C.chipSm, on ? C.chipOn : C.chipOff) }, cbEl, monthLabel(mo).slice(0, 3));
  };
  const yearGroups: Array<{ year: string; months: Month[] }> = [];
  for (const mo of allMonths) {
    const g = yearGroups[yearGroups.length - 1];
    const y = mo.slice(0, 4);
    if (g && g.year === y) g.months.push(mo);
    else yearGroups.push({ year: y, months: [mo] });
  }

  /** click a year label: select every month of it, or deselect them all if already on */
  const toggleYear = (months: Month[]): void => {
    const allOn = months.every((mo) => !view.hiddenMonths.includes(mo));
    view.hiddenMonths = allOn
      ? [...view.hiddenMonths, ...months]
      : view.hiddenMonths.filter((x) => !months.includes(x));
    persist(); emit();
  };
  // ---- filter toolbar: labeled groups, months spanning the full width ----
  settingsSel.title = 'category settings used to classify the transactions';
  // 'all' / 'none' sit in the caption row right next to the counted "Months" label;
  // same structure field() builds (caption above, controls below)
  const monthsField = h('div', { class: 'col-span-full flex min-w-0 flex-col gap-1.5' },
    h('span', { class: cx(C.label, 'flex items-center gap-1') },
      Ic(CalendarDays, 'size-3.5'), `Months (${visibleMonths.length})`,
      h('button', { dataset: { fk: 'smo-all' }, class: cx(C.link, 'normal-case'), text: 'all', onclick: () => { view.hiddenMonths = []; persist(); emit(); } }),
      h('button', { dataset: { fk: 'smo-none' }, class: cx(C.link, 'normal-case'), text: 'none', onclick: () => { view.hiddenMonths = [...allMonths]; persist(); emit(); } })),
    h('div', { class: 'flex min-w-0 flex-col gap-1.5' },
      ...yearGroups.map((g) => h('div', { class: 'flex items-start gap-1.5' },
        h('button', {
          dataset: { fk: `syear-${g.year}` },
          class: 'w-9 shrink-0 cursor-pointer border-0 bg-transparent p-0 pt-1 text-left text-[11px] font-semibold tabular-nums text-muted-foreground transition-colors hover:text-foreground',
          title: `select / deselect all of ${g.year}`,
          text: g.year,
          onclick: () => toggleYear(g.months),
        }),
        // the months are their own column: a wrapped row starts under the first
        // chip instead of sliding left under the year label
        h('div', { class: 'flex min-w-0 flex-1 flex-wrap items-center gap-1.5' }, ...g.months.map(chipFor))))));
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
      field('Filter', SlidersHorizontal, settingsSel, ...sourceBtns),
      dateField,
      showField,
      monthsField,
      averageField,
    ),
  );

  // ---- matrix ----
  // Header and body are two stacked tables sharing the same <col> widths: the header
  // box sticks at menu level while the body box owns the horizontal scroll (a single
  // table inside an overflow wrapper would trap the sticky header in that wrapper).
  // The header follows the body's scrollLeft. Category, Average and Total are the
  // static columns — fixed width, no resize handle, Pin icon; clicking one of them
  // toggles just that column between frozen at its table edge (blue pin) and
  // scrolling free with the months.
  // The month columns are resizable (drag the right edge of a header, double-click
  // the handle for the automatic width — widths live in localStorage under
  // banking.spendingColW) and grab-draggable for panning.
  const expanded = new Set<string>();
  // border-separate (not collapse): with collapse, browsers drop a sticky cell's
  // border once it detaches from the grid — the 2px header rule would vanish.
  const mkTable = (): { table: HTMLElement; colgroup: HTMLElement } => {
    const table = h('table', { class: 'border-separate border-spacing-0 text-[13px]', style: { tableLayout: 'fixed' } });
    const colgroup = h('colgroup');
    table.appendChild(colgroup);
    return { table, colgroup };
  };
  const head = mkTable();
  const body = mkTable();
  const colEntries: Array<{ key: string; def: number; fixed: boolean }> = [];

  // ---- required column widths ----
  // every number column gets at least the width of its widest cell, so a value is
  // never clipped to "…". The table font is monospace (1 glyph = 1 advance), so one
  // probe measures the advance and the rest is arithmetic; +24px covers the cell
  // padding (2 × 10px) with a little slack.
  const chW = (() => {
    const probe = h('span', { style: { position: 'fixed', left: '-9999px', top: '0', whiteSpace: 'pre', fontSize: '13px' }, text: '0'.repeat(20) });
    document.body.appendChild(probe);
    const w = probe.getBoundingClientRect().width / 20;
    probe.remove();
    return w > 0 ? w : 7.8; // fallback ≈ ui-monospace at 13px
  })();
  const need = new Map<string, number>();
  const noteW = (key: string, s: string): void => {
    need.set(key, Math.max(need.get(key) ?? 0, Math.ceil(s.length * chW) + 24));
  };
  const ZERO: Agg = { debit: 0, credit: 0, count: 0 };
  for (const node of flat) {
    const mv = sub.get(node.tag) ?? new Map<Month, Agg>();
    for (const mo of monthCols) noteW(mo, cellText(measureOf(mv.get(mo) ?? ZERO, measure), measure));
    const t = measureOf(subtreeTotals(mv), measure);
    noteW('total', cellText(t, measure));
    noteW('avg', cellText(averageOf(t), measure));
  }
  // the three footer rows carry their own (measure-independent) numbers per column
  for (const mo of monthCols) {
    const a = footOf(mo);
    noteW(mo, cellText(a.credit, 'income'));
    noteW(mo, cellText(a.debit, 'expense'));
    noteW(mo, cellText(netOf(a), 'net'));
  }
  noteW('total', cellText(footTot.credit, 'income'));
  noteW('total', cellText(footTot.debit, 'expense'));
  noteW('total', cellText(netOf(footTot), 'net'));
  noteW('avg', cellText(averageOf(footTot.credit), 'income'));
  noteW('avg', cellText(averageOf(footTot.debit), 'expense'));
  noteW('avg', cellText(averageOf(netOf(footTot)), 'net'));
  // the static number columns keep their 120px look but grow when a value needs more
  const totW = Math.max(120, need.get('total') ?? 0);
  const avgW = Math.max(120, need.get('avg') ?? 0);
  /** effective width: the saved drag-resize width, but never below the column's
   *  required minimum — that is what guarantees no "…" on numbers */
  const effW = (key: string, def: number, fixed: boolean): number =>
    fixed ? def : Math.max(spColW[key] ?? 0, def);

  /** both tables must always occupy exactly the same width */
  const syncTableW = (): void => {
    let px = 0;
    for (const e of colEntries) px += effW(e.key, e.def, e.fixed);
    // definite px width + min-width:100% so the tables fill a wider row
    for (const t of [head.table, body.table]) {
      t.style.width = `${px}px`;
      t.style.minWidth = '100%';
    }
  };

  /** register one column (a <col> in each table); fixed columns get no resize handle */
  const addCol = (key: string, th: HTMLElement, def: number, fixed = false): void => {
    colEntries.push({ key, def, fixed });
    const start = effW(key, def, fixed);
    const cols = [h('col'), h('col')];
    for (const c of cols) c.style.width = `${start}px`;
    head.colgroup.appendChild(cols[0]);
    body.colgroup.appendChild(cols[1]);
    if (fixed) return;
    th.appendChild(colResizeHandle({
      width: () => effW(key, def, false),
      apply: (px) => {
        if (px === 0) delete spColW[key];
        else spColW[key] = px;
        const now = effW(key, def, false);
        for (const c of cols) c.style.width = `${now}px`;
        syncTableW();
      },
      commit: () => saveSpColW(),
      min: Math.max(SP_MIN_W, def), // dragging cannot reintroduce a clipped number
    }));
  };

  /** the two boxes: the header sticks below the menu, the body scrolls horizontally.
   *  Both sit in a plain wrapper div: a sticky element releases when its containing
   *  block scrolls past, and the wrapper's block is exactly the table — so the header
   *  unsticks at the bottom of the table instead of floating over the charts below it. */
  const headBox = h('div', { class: cx(C.card, 'sticky top-[var(--appbar-h)] z-20 overflow-x-hidden border-b-0') }, head.table);
  const bodyBox = h('div', { class: cx(C.card, 'overflow-x-auto border-t-0') }, body.table);
  const tableWrap = h('div', {}, headBox, bodyBox);
  bodyBox.addEventListener('scroll', () => { headBox.scrollLeft = bodyBox.scrollLeft; }, { passive: true });

  // grab-and-slide panning on the non-static content: dragging a month header or a
  // month cell slides the table sideways (the resize handle stops the drag before
  // it starts, static columns never begin one)
  const isMonthCell = (t: HTMLElement): boolean => !!t.closest('[data-mo]');
  attachDragPan(bodyBox, headBox, isMonthCell);
  attachDragPan(bodyBox, bodyBox, isMonthCell);

  // ---- static columns: each one pinned (frozen at a table edge) or free ----
  // per-column auto default: on from the app's `wide` breakpoint up, off on tablet
  // and below; clicking a static header stores an explicit choice for that column.
  // One dependency: Average may only freeze while Total freezes too (it pins just
  // left of it) — Average-on pulls Total on, Total-off drops Average off; the other
  // two combinations (Total on + Average off, Average off + Total on) are allowed.
  wirePinAutoResize();
  type PinKey = 'cat' | 'avg' | 'total';
  const pins = view.pinStatic ?? {};
  const auto = autoPin();
  const pinOf = (k: PinKey): boolean => pins[k] ?? auto;
  const togglePin = (k: PinKey): void => {
    const next: Partial<Record<PinKey, boolean>> = { ...pins, [k]: !pinOf(k) };
    if (k === 'avg' && next.avg) next.total = true; // Average on → Total on too
    if (k === 'total' && next.total === false) next.avg = false; // Total off → Average off
    view.pinStatic = next;
    persist(); emit();
  };
  const catPinned = pinOf('cat');
  const totPinned = pinOf('total');
  const avgPinned = pinOf('avg') && totPinned; // effective state, never violates the rule
  const pinHint = (name: string, edge: string, on: boolean): string =>
    on ? `${name} pinned to the ${edge} — click to unpin` : `${name} scrolls with the months — click to pin it to the ${edge}`;
  // blue while pinned, muted while free
  const staticIcon = (on: boolean): SVGSVGElement => Ic(Pin, cx('size-3.5 shrink-0', on ? 'text-primary' : 'text-muted-foreground'));

  const hrow = h('tr');
  // static corner cell: pinned to the left edge, above the scrolling months
  const catTh = h('th', { class: cx(C.th, 'cursor-pointer select-none', catPinned && 'sticky left-0 z-6'), title: pinHint('Category', 'left edge', catPinned), onclick: () => togglePin('cat') },
    h('span', { class: 'inline-flex items-center gap-1.5' }, staticIcon(catPinned), 'Category'));
  hrow.appendChild(catTh);
  addCol('cat', catTh, 260, true);
  for (const mo of monthCols) {
    // no per-column hide checkbox here — months are toggled in the toolbar above
    const th = h('th', { class: cx(C.th, 'text-right cursor-grab select-none'), dataset: { mo }, text: monthLabel(mo) });
    hrow.appendChild(th);
    addCol(mo, th, Math.max(SP_MIN_W, need.get(mo) ?? 0));
  }
  // Average first, Total last — each freezes at the right edge on its own; Average
  // sits just left of Total by Total's actual (content-driven) width, and at the
  // very edge when Total scrolls free
  const avgFormula = `Total ÷ ${visibleMonths.length} selected month${visibleMonths.length === 1 ? '' : 's'} (months without spending count as 0)`;
  if (showAvg) {
    const avgTh = h('th', {
      class: cx(C.th, C.num, 'cursor-pointer select-none', avgPinned && 'sm:sticky z-6'),
      title: `${pinHint('Average', 'right edge', avgPinned)}${!avgPinned && !totPinned ? ' (pins Total too)' : ''} · ${avgFormula}`,
      onclick: () => togglePin('avg'),
    }, h('span', { class: 'inline-flex items-center gap-1.5' }, staticIcon(avgPinned), 'Average'));
    if (avgPinned) avgTh.style.right = `${totW}px`;
    hrow.appendChild(avgTh);
    addCol('avg', avgTh, avgW, true);
  }
  const totTh = h('th', { class: cx(C.th, C.num, 'cursor-pointer select-none', totPinned && 'sm:sticky sm:right-0 z-6'), title: pinHint('Total', 'right edge', totPinned), onclick: () => togglePin('total') },
    h('span', { class: 'inline-flex items-center gap-1.5' }, staticIcon(totPinned), 'Total'));
  hrow.appendChild(totTh);
  addCol('total', totTh, totW, true);
  head.table.appendChild(h('thead', {}, hrow));

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
    // a cash-movement category: show a badge that explains it and toggles whether its
    // rows count as spending (excluded by default — the money moves to the wallet)
    const cashMv = cat?.cashMovement ?? null;
    const counted = countedCash.has(tag);
    if (cashMv) nameLabel.title = `${nameLabel.title} (Cash movement)`;
    const cashBadge = cashMv ? h('button', {
      class: cx('inline-flex shrink-0 cursor-pointer items-center gap-1 border bg-transparent px-1.5 py-px font-sans text-[10px] select-none', counted ? C.chipOk : C.chipWarn),
      attrs: { type: 'button', 'aria-pressed': counted ? 'true' : 'false' },
      title: counted
        ? `${tag} (Cash movement) — counted in Spending totals; click to exclude them again`
        : `${tag} (Cash movement) — excluded from Spending totals (transfers, not spending); click to count them here anyway`,
      onclick: (e: MouseEvent) => { e.stopPropagation(); toggleCashCounted(tag); },
    }, Ic(Banknote, 'size-3'), counted ? 'counted' : 'Cash movement') : null;
    const badge = hasDateRange
      ? h('span', { class: 'border border-warning/30 bg-warning/10 px-1.5 py-px text-[10px] text-warning', title: 'category date range', text: `${cat!.dateFrom ? dmy(cat!.dateFrom) : '…'}–${cat!.dateTo ? dmy(cat!.dateTo) : '…'}` })
      : null;
    const offBadge = !cat?.enabled && !isUncat ? h('span', { class: C.badgeMuted, text: 'disabled' }) : null;
    // the hover tint must stay OPAQUE (pre-blended muted/40 over the card, the exact
    // color the row itself composites to): a semi-transparent bg on this sticky cell
    // would let the month values sliding underneath it show through the name column
    const nameCell = h('td', { class: cx('flex items-center gap-2 overflow-hidden border-b border-border px-2.5 py-2 whitespace-nowrap group-hover:bg-[color-mix(in_srgb,var(--muted)_40%,var(--card))]', catPinned && 'sticky left-0 z-3', stripe) },
      toggle, cb, dot, nameLabel, cashBadge, badge, offBadge);
    nameCell.style.paddingLeft = `${10 + node.depth * 22}px`;
    tr.appendChild(nameCell);

    const monthVals = sub.get(tag) ?? new Map();
    for (const mo of monthCols) {
      const a = monthVals.get(mo) ?? { debit: 0, credit: 0, count: 0 };
      const v = measureOf(a, measure);
      tr.appendChild(h('td', { class: cx(C.td, C.num, SP_CELL, 'cursor-grab', v < 0 && 'text-danger', a.count === 0 && 'text-muted-foreground/40'), dataset: { mo }, text: cellText(v, measure) }));
    }
    const tot = measureOf(subtreeTotals(sub.get(tag)), measure);
    if (showAvg) {
      const avg = averageOf(tot);
      const avgTd = h('td', { class: cx(C.td, C.num, SP_CELL, 'bg-subtle', avgPinned && 'sm:sticky z-3', avg < 0 && 'text-danger'), text: cellText(avg, measure) });
      if (avgPinned) avgTd.style.right = `${totW}px`; // just left of the pinned Total
      tr.appendChild(avgTd);
    }
    tr.appendChild(h('td', { class: cx(C.td, C.num, SP_CELL, 'bg-subtle font-semibold', totPinned && 'sm:sticky sm:right-0 z-3', tot < 0 && 'text-danger'), text: cellText(tot, measure) }));
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
      class: cx('flex items-center border-b border-border border-t-2 bg-subtle px-2.5 py-2 whitespace-nowrap', catPinned && 'sticky left-0 z-3', SP_CELL),
      text: label,
    }));
    const numCell = (v: number, tint: string | false, mo?: Month, right?: number): void => {
      const td = h('td', { class: cx(C.td, C.num, SP_CELL, 'border-t-2', tint, v < 0 && 'text-danger'), dataset: mo ? { mo } : undefined, text: cellText(v, fmt) });
      if (right !== undefined) td.style.right = `${right}px`;
      tr.appendChild(td);
    };
    for (const mo of monthCols) numCell(of(footOf(mo)), 'cursor-grab', mo);
    if (showAvg) numCell(averageOf(of(footTot)), avgPinned ? 'sm:sticky z-3 bg-subtle' : 'bg-subtle', undefined, avgPinned ? totW : undefined);
    numCell(of(footTot), totPinned ? 'sm:sticky sm:right-0 z-3 bg-subtle' : 'bg-subtle');
    tbody.appendChild(tr);
  };
  footRow('Total Income', 'sum of all income (credits) over the visible categories — not a category row', 'income', (a) => a.credit);
  footRow('Total Expenses', 'sum of all expenses (debits) over the visible categories — not a category row', 'expense', (a) => a.debit);
  footRow('Total Net', 'income − expenses over the visible categories — not a category row', 'net', netOf);

  body.table.appendChild(tbody);
  syncTableW();
  container.appendChild(tableWrap);
  attachCellSelect(tbody); // one click picks the cell's own text — no column marking here

  function toggleCashCounted(tag: string): void {
    const set = new Set(view.cashInSpending);
    if (set.has(tag)) set.delete(tag); else set.add(tag);
    view.cashInSpending = [...set];
    persist(); emit();
  }

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
    const txs = (aggAll.txByTag.get(tag) ?? []).filter((t) => {
      const mo = monthKey(t.bookingDate || t.valueDate);
      return visibleMonths.includes(mo);
    });
    const tree = buildTree(reportSettings);
    const node = flattenTree(tree).find((n) => n.tag === tag);
    const inSubtree = new Set<string>();
    const collect = (n: TreeNode) => { inSubtree.add(n.tag); n.children.forEach(collect); };
    if (node) collect(node);
    // respect hidden months in the subtree list too (Uncategorized renders from this)
    const visibleInRange = scopeRows.filter((t) => visibleMonths.includes(monthKey(t.bookingDate || t.valueDate)));
    const subtreeTxs = visibleInRange.filter((t) => inSubtree.has(matchTx(t, reportSettings)));
    cell.appendChild(h('div', { class: 'flex items-baseline gap-3.5 px-3.5 pt-2.5 pb-1' },
      h('b', { text: `${tag} — ${txs.length} transactions` }),
      h('span', { class: C.muted, text: `directly matched (own rules); total incl. subcategories: ${subtreeTxs.length}` }),
    ));
    // when these rows are listed but left out of the totals, say so right here
    if (cashTags.has(tag) && !countedCash.has(tag)) {
      cell.appendChild(h('div', { class: cx(C.chipWarn, 'mx-3.5 mb-1.5 inline-flex') },
        Ic(Banknote, 'size-3'),
        'Cash movement — these rows move money into/out of your wallet, so they are listed here but not counted in Spending totals. Click the ',
        h('b', { text: 'Cash movement' }),
        ' badge on the row to count them.'));
    }
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
  // Hiding a parent's own assignments does not hide its independently selected
  // children. Retain that chart grouping when visible children contribute data.
  const rootVisible = roots.filter((r) => !isHidden(r.tag) || subtreeTotals(chartSub.get(r.tag)).count > 0);
  const series = rootVisible.map((r) => ({
    name: r.tag,
    color: r.category?.color ?? '#9aa2ad',
    values: visibleMonths.map((mo) => {
      const a = (chartSub.get(r.tag) ?? new Map()).get(mo) ?? { debit: 0, credit: 0, count: 0 };
      return measureOf(a, measure);
    }),
  }));
  // measureName (defined with the measure) labels the chart cards

  /** Share chart: the 12 biggest top-level categories, each optionally followed by its
   *  own sub-categories, grouped under it. Percentages stay relative to the top-level
   *  magnitudes, so a parent and its children never count twice. */
  const shareSubs = view.shareSubs === true;
  const valueOf = (n: TreeNode): number => measureOf(subtreeTotals(chartSub.get(n.tag)), measure);
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

  // ---- month drill-down: click a bar of the Monthly chart and the card shows that
  // single month like the Share chart (horizontal share bars), but with extra detail
  // for the month — Expenses/Income/Net/count, and a transaction count per category.
  // 'Return' switches the card back to the Monthly chart. (Share chart itself stays
  // over the full range; the 'Sub-categories' toggle applies to both views.) ----
  const focus: Month | null = monthFocus && visibleMonths.includes(monthFocus) ? monthFocus : null;
  const monthAgg = (tag: string, mo: Month): Agg => (chartSub.get(tag) ?? new Map<Month, Agg>()).get(mo) ?? ZERO;
  const statBox = (label: string, value: string, tone: string): HTMLElement =>
    h('div', { class: 'border border-border bg-subtle px-2.5 py-1.5' },
      h('div', { class: C.label, text: label }),
      h('div', { class: cx('mt-0.5 text-[14px] font-bold tabular-nums', tone), text: value }));

  /** the month view: a summary strip over a share list of exactly that month */
  const monthDetail = (mo: Month): HTMLElement => {
    const valOf = (n: TreeNode): number => measureOf(monthAgg(n.tag, mo), measure);
    const byMonthMag = (a: TreeNode, b: TreeNode): number => Math.abs(valOf(b)) - Math.abs(valOf(a));
    const items: ShareItem[] = [];
    for (const r of [...rootVisible].sort(byMonthMag).slice(0, 12)) {
      const a = monthAgg(r.tag, mo);
      items.push({ name: r.tag, color: r.category?.color ?? '#9aa2ad', value: valOf(r), depth: 0, note: `${num0(a.count)} tx` });
      if (!shareSubs) continue;
      for (const ch of [...r.children].sort(byMonthMag)) {
        if (isHidden(ch.tag)) continue;
        items.push({ name: ch.tag, color: ch.category?.color ?? '#9aa2ad', value: valOf(ch), depth: 1, note: `${num0(monthAgg(ch.tag, mo).count)} tx` });
      }
    }
    const fa = footOf(mo);
    const net = netOf(fa);
    return h('div', {},
      h('div', { class: 'mb-2.5 grid grid-cols-[repeat(auto-fit,minmax(110px,1fr))] gap-2' },
        statBox('Expenses', money(fa.debit), 'text-danger'),
        statBox('Income', money(fa.credit), 'text-success'),
        statBox('Net', money(net), net >= 0 ? 'text-success' : 'text-danger'),
        statBox('Transactions', num0(fa.count), '')),
      shareBars(items, `${measureName} — ${monthLabel(mo)}`, {
        total: rootVisible.reduce((s, r) => s + valOf(r), 0),
        denominator: rootVisible.reduce((s, r) => s + Math.abs(valOf(r)), 0),
      }));
  };

  const monthlyTitleKids: Array<Node | string> = focus
    ? [Ic(CalendarDays, 'size-4'), `Month — ${monthLabel(focus)}`, h('span', { class: 'flex-1' }),
        h('button', {
          class: cx(C.togBase, 'border-border bg-card text-foreground hover:border-input'),
          dataset: { fk: 'smonth-return' },
          title: 'show the Monthly chart again',
          onclick: () => { monthFocus = null; emit(); },
        }, Ic(ArrowLeft, 'size-3'), 'Return')]
    : [Ic(ChartColumn, 'size-4'), `Monthly — ${measureName}`,
        ...(series.length ? [h('span', { class: 'flex-1' }), h('span', { class: 'text-[10.5px] font-normal', text: 'click a month bar for details' })] : [])];

  container.appendChild(h('div', { class: 'mt-3.5 grid gap-3' },
    h('div', { class: cx(C.card, 'min-w-0 px-4 py-3') },
      h('h3', { class: 'mb-2 flex items-center gap-1.5 text-[13px] text-muted-foreground' }, ...monthlyTitleKids),
      focus
        ? monthDetail(focus)
        : series.length
          ? stackedBars(visibleMonths.map(monthLabel), series, 260, {
              onMonthClick: (i) => { monthFocus = visibleMonths[i] ?? null; emit(); },
            })
          : h('div', { class: C.muted, text: 'no data' })),
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

  // the header print/export buttons open these dialogs while this tab is active
  setTabPrintHandler(() => openPrintDialog());
  setTabExportHandler(() => openExportDialog());

  /** the spending table as CSV, as displayed: every row (dimmed categories too
   *  unless the dialog turns them off), the shown month columns in order, Average
   *  where on, Total last, and the three footer rows. Amounts as plain signed
   *  numbers (`-1234.50`), not the screen glyphs. */
  function exportSpendingCsv(includeHidden: boolean): void {
    const avgCol: string[] = showAvg ? ['Average'] : [];
    const rows: string[][] = [['Category', ...monthCols.map(monthLabel), ...avgCol, 'Total']];
    for (const node of flat) {
      if (!includeHidden && isHidden(node.tag)) continue;
      const mv = sub.get(node.tag) ?? new Map<Month, Agg>();
      const tot = measureOf(subtreeTotals(mv), measure);
      rows.push([
        node.tag,
        ...monthCols.map((mo) => exportAmount(measureOf(mv.get(mo) ?? ZERO, measure))),
        ...(showAvg ? [exportAmount(averageOf(tot))] : []),
        exportAmount(tot),
      ]);
    }
    const footLine = (label: string, of: (a: Agg) => number): string[] => [
      label,
      ...monthCols.map((mo) => exportAmount(of(footOf(mo)))),
      ...(showAvg ? [exportAmount(averageOf(of(footTot)))] : []),
      exportAmount(of(footTot)),
    ];
    rows.push(footLine('Total Income', (a) => a.credit));
    rows.push(footLine('Total Expenses', (a) => a.debit));
    rows.push(footLine('Total Net', netOf));
    downloadCsv(`spending-${measure}-${fileStamp()}.csv`, rows);
    const shownRows = includeHidden ? flat.length : flat.length - flat.filter((n) => isHidden(n.tag)).length;
    toast(`Spending table exported — ${shownRows} categories × ${monthCols.length} month${monthCols.length === 1 ? '' : 's'}`);
  }

  /** The dialog the header export button opens: spells out what the file would
   *  contain — rows, month columns, the shown measure, Total/Average, the footer —
   *  and lets the user leave out the dimmed (unchecked) categories; 'Download CSV'
   *  confirms, so nothing is downloaded unseen. */
  function openExportDialog(): void {
    if (visibleMonths.length === 0 || sCount === 0) {
      toast('Nothing to export — no transactions in this view', 'err');
      return;
    }
    const pill = (t: string): HTMLElement => h('span', { class: 'border border-border bg-subtle px-2 py-0.5 text-xs', text: t });
    const contents = [
      `${num0(flat.length)} category rows (tree order, sub-categories included)`,
      monthCols.length === 0
        ? 'no month columns — Only Averages is on'
        : `${monthCols.length} month column${monthCols.length === 1 ? '' : 's'}: ${monthCols.map(monthLabel).join(', ')}`,
      `${measureName} numbers per cell`,
      'Total column',
      ...(showAvg ? ['Average column'] : []),
      'footer rows: Total Income, Total Expenses, Total Net',
    ];
    const hiddenCount = flat.filter((n) => isHidden(n.tag)).length;
    const hiddenChk = hiddenCount > 0
      ? printCheck('Include dimmed categories', true, `${hiddenCount} ${hiddenCount === 1 ? 'category is' : 'categories are'} unchecked — shown dimmed in the table but not counted in the totals. They are part of the display, so they are exported too; turn this off to leave them out.`)
      : null;
    const controls = h('div', { class: 'flex flex-col gap-2.5' },
      field('Table contains', ReceiptText, ...contents.map(pill)),
      hiddenChk ? field('Hidden categories', Eye, hiddenChk.el) : null,
      h('p', { class: cx(C.muted, 'text-[12.5px]') },
        'One line per category, comma-separated; amounts as plain signed numbers (1234.50 / -1234.50), empty cells as 0.00, UTF-8 with BOM so Excel opens it cleanly.'));
    openPrintModal('Export spending table as CSV', controls, () => exportSpendingCsv(hiddenChk ? hiddenChk.cb.checked : true), 'Download CSV');
  }

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
      h('span', { class: 'flex min-w-0 items-center gap-1.5' },
        t.cashEntryId ? Ic(Banknote, 'size-3.5 shrink-0 text-success') : null,
        h('span', { class: 'truncate', text: t.text, title: t.cashEntryId ? `Cash · ${t.text}` : t.text })),
      h('span', { class: cx('text-right tabular-nums', t.credit > 0 ? 'text-success' : 'text-danger'), text: t.credit > 0 ? `+${num2(t.credit)}` : `−${num2(t.debit)}` }),
    ));
  }
  if (txs.length > shown.length) list.appendChild(h('div', { class: cx(C.muted, 'px-2 pt-1'), text: `… ${txs.length - shown.length} more` }));
  el.appendChild(list);
}
