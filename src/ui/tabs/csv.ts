import { ArrowUpDown, Banknote, CalendarRange, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ChevronUp, FileSpreadsheet, ListFilter, Printer, RotateCcw, Search, Tags, Type, Wand2 } from 'lucide';
import type { IconNode } from 'lucide';
import type { Tx } from '../../types';
import { state, emit, removeFile } from '../../state';
import { openMapperManager } from '../uploadFlow';
import { csvPicker, noCsvCard } from '../addCsv';
import { defaultCsvFilter, filterTxs, highlight, txAmount, type CsvFilter } from '../search';
import { matchTx, UNCAT } from '../../categories/engine';
import { C, clear, cx, dmy, field, h, num0, num2, readableOn, toast } from '../util';
import { attachCellSelect, clearColumnSelect } from '../cellSelect';
import { colResizeHandle } from '../colResize';
import { Ic } from '../icons';
import { buildCsvPrintDoc, fontControls, mergedAmountCell, mergedDateCell, mergedDescCell, mergedNetTotal, openPrintModal, printCheck, printDateInput, printHtml, printRadio, savePrintStyle, setTabPrintHandler, type CsvPrintColumn } from '../print';

type SortKey = 'date' | 'amount' | 'text';
interface CsvTabState {
  sortKey: SortKey;
  sortDir: 1 | -1;
  page: number;
  pickerOpen: boolean;
  pageSize: number;
}
const PAGE_SIZES = [25, 50, 100, 250, 500, 0]; // 0 = show all
const PGKEY = 'banking.csvPageSize';
function loadPageSize(): number {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(PGKEY);
  } catch { /* ignore */ }
  const n = Number(raw);
  // 250 rows: a full month of transactions in one screen on a desktop
  return raw !== null && PAGE_SIZES.includes(n) ? n : 250;
}
const ui: CsvTabState = { sortKey: 'date', sortDir: -1, page: 0, pickerOpen: false, pageSize: loadPageSize() };

// ---- resizable columns ----
type ColKey = 'date' | 'value' | 'ref' | 'text' | 'cat' | 'credit' | 'debit';
interface ColDef { key: ColKey; label: string; /** original German header in the CSV files */ de?: string; def: number; sort?: SortKey; num?: boolean }
const COLS: ColDef[] = [
  { key: 'date', label: 'Booking date', de: 'Buchungsdatum', def: 110, sort: 'date', num: true },
  { key: 'value', label: 'Value date', de: 'Valuta', def: 95, num: true },
  { key: 'ref', label: 'Order no.', de: 'Auftragsnummer', def: 170 },
  { key: 'text', label: 'Description', de: 'Buchungstext', def: 460, sort: 'text' },
  { key: 'cat', label: 'Category', def: 140 },
  { key: 'credit', label: 'Credit', de: 'Gutschrift', def: 105, sort: 'amount', num: true },
  { key: 'debit', label: 'Debit', de: 'Belastung', def: 105, num: true },
];
const MIN_COL_W = 64;
const COLW_KEY = 'banking.csvColW';
/** cell classes for clipping long content with an ellipsis */
const CELL = 'overflow-hidden text-ellipsis';

function loadColW(): Record<ColKey, number> {
  let saved: Record<string, unknown> = {};
  try {
    saved = JSON.parse(localStorage.getItem(COLW_KEY) ?? '{}') as Record<string, unknown>;
  } catch { saved = {}; }
  const out = {} as Record<ColKey, number>;
  for (const c of COLS) {
    const n = Number(saved[c.key]);
    out[c.key] = Number.isFinite(n) && n >= MIN_COL_W ? n : c.def;
  }
  return out;
}
const colW = loadColW();
function saveColW(): void {
  try {
    localStorage.setItem(COLW_KEY, JSON.stringify(colW));
  } catch { /* ignore */ }
}

// ---- print: remembered dialog options ----
interface CsvPrintOpts {
  cols: ColKey[];
  merged: boolean;
  catDesc: boolean;
  datesMerged: boolean;
  sort: 'as' | 'newest' | 'oldest';
  pageNums: boolean;
  landscape: boolean;
  boldIncome: boolean;
  totals: boolean;
}
const PRINT_OPTS_KEY = 'banking.csvPrintOpts';
const LEGACY_PRINT_COLS_KEY = 'banking.csvPrintCols';
/**
 * First-open state of the CSV print dialog: booking date + description, one
 * signed Amount column with income in bold, category folded into the
 * description, current order, landscape. Everything the user changes is
 * remembered (localStorage) and comes back on the next print.
 */
function defaultPrintOpts(): CsvPrintOpts {
  return {
    cols: ['date', 'text'],
    merged: true,
    catDesc: true,
    datesMerged: false,
    sort: 'as',
    pageNums: false,
    landscape: true,
    boldIncome: true,
    totals: false,
  };
}
function normalizeCols(raw: unknown): ColKey[] | null {
  if (!Array.isArray(raw)) return null;
  const cols = raw.filter((k): k is ColKey => typeof k === 'string' && COLS.some((c) => c.key === k));
  return cols.length > 0 ? cols : null;
}
function loadPrintOpts(): CsvPrintOpts {
  try {
    const raw = JSON.parse(localStorage.getItem(PRINT_OPTS_KEY) ?? 'null') as Partial<CsvPrintOpts> | null;
    if (raw && typeof raw === 'object') {
      const d = defaultPrintOpts();
      return {
        cols: normalizeCols(raw.cols) ?? d.cols,
        merged: raw.merged === true,
        catDesc: raw.catDesc === true,
        datesMerged: raw.datesMerged === true,
        sort: raw.sort === 'newest' || raw.sort === 'oldest' ? raw.sort : 'as',
        pageNums: raw.pageNums === true,
        landscape: raw.landscape === true,
        boldIncome: raw.boldIncome === true,
        totals: raw.totals === true,
      };
    }
    // migrate the old column-only selection
    const legacy = normalizeCols(JSON.parse(localStorage.getItem(LEGACY_PRINT_COLS_KEY) ?? 'null'));
    if (legacy) return { ...defaultPrintOpts(), cols: legacy };
  } catch { /* ignore */ }
  return defaultPrintOpts();
}
let printOpts = loadPrintOpts();

/** true briefly after a resize drag, so the click that follows does not sort */
let justDragged = false;

/** drag handle on a column edge: drag to resize, double-click to reset to the default width */
function resizer(c: ColDef, col: HTMLTableColElement, sync: () => void): HTMLElement {
  return colResizeHandle({
    width: () => colW[c.key],
    apply: (px) => {
      colW[c.key] = px === 0 ? c.def : px;
      col.style.width = `${colW[c.key]}px`;
      sync();
    },
    commit: () => {
      justDragged = true; // the click that ends a drag must not sort the column
      setTimeout(() => { justDragged = false; }, 0);
      saveColW();
    },
    min: MIN_COL_W,
    title: 'drag to resize · double-click to reset',
  });
}

function categoryColor(tag: string): string {
  if (tag === UNCAT) return '#9aa2ad';
  return state.settings.categories.find((c) => c.tag === tag)?.color ?? '#9aa2ad';
}

export function renderCsvTab(container: HTMLElement): void {
  clearColumnSelect(); // a re-render drops the marked cells; remove the leftover copy buffer too
  clear(container);
  const f: CsvFilter = state.csvFilter;

  // ---- files row ----
  const { input: fileInput, button: addCsvBtn } = csvPicker();
  const filesBox = h('div', { class: 'mb-3 flex flex-wrap items-center gap-2' },
    addCsvBtn,
    fileInput,
    h('button', { class: C.btn, title: 'detect, create and manage CSV schemas (mappers)', onclick: () => openMapperManager() },
      Ic(Wand2, 'size-3.5'), 'Mappers…'),
    ...state.files.map((file) => h('span', { class: cx('inline-flex items-center gap-1.5 border px-3 py-1 text-[12.5px]', file.mapper ? 'border-border bg-card' : 'border-warning/50 bg-warning/10') },
      Ic(FileSpreadsheet, 'size-3.5 text-muted-foreground'),
      h('b', { text: file.name }),
      h('span', { class: C.muted, text: ` ${file.rows} rows` }),
      h('span', { class: cx(C.muted, 'text-[11px]'), text: file.mapper ? ` · schema: ${file.mapper}` : ' · needs schema' }),
      h('button', {
        class: C.linkDanger, text: 'remove', onclick: async () => {
          if (confirm(`Remove ${file.name} from the loaded data?`)) await removeFile(file.name);
        },
      }))),
  );
  container.appendChild(filesBox);

  // nothing stored yet: an info box that opens the file picker on click (no table to filter)
  if (state.files.length === 0) {
    container.appendChild(noCsvCard());
    return;
  }

  // ---- filter bar: row 1 = search + rules + direction, row 2 = labeled groups ----
  const mkTog = (label: string, on: boolean, title: string, key: 'caseSensitive' | 'fuzzy') =>
    h('button', {
      class: cx(C.togBase, on ? C.togOn : C.togOff), text: label, title,
      onclick: () => { f[key] = !f[key]; ui.page = 0; refresh(); },
    });
  const textIn = h('input', { class: cx(C.input, 'w-full pr-[76px] pl-9'), dataset: { fk: 'csv-text' }, attrs: { type: 'text', value: f.text, placeholder: 'search description, IBAN, reference…' } }) as HTMLInputElement;
  textIn.oninput = () => { f.text = textIn.value; ui.page = 0; refresh(); };
  const searchWrap = h('div', { class: 'relative min-w-[220px] flex-1' },
    h('span', { class: 'pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground' }, Ic(Search, 'size-4')),
    textIn,
    h('div', { class: 'absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-1' },
      mkTog('Aa', f.caseSensitive, 'case-sensitive search', 'caseSensitive'),
      mkTog('≈ fuzzy', f.fuzzy, 'fuzzy (characters in order)', 'fuzzy')));

  // amount boxes are plain text (inputmode=decimal): a type=number field does not
  // expose selectionStart, so the re-render could not restore the caret and the
  // typed digits ended up reversed. Anything that is not a number is stripped here.
  const amountIn = (key: 'minAmount' | 'maxAmount', fk: string, label: string, title: string): HTMLInputElement => {
    const inp = h('input', {
      class: cx(C.input, 'w-[92px]'),
      dataset: { fk },
      attrs: {
        type: 'text', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false',
        value: f[key], placeholder: label, 'aria-label': `${label} amount`, title,
      },
    }) as HTMLInputElement;
    inp.oninput = () => {
      const clean = inp.value.replace(/[^\d.,'’\s]/g, '');
      if (clean !== inp.value) {
        const caret = Math.min(inp.selectionStart ?? clean.length, clean.length);
        inp.value = clean;
        inp.setSelectionRange(caret, caret);
      }
      f[key] = clean;
      ui.page = 0;
      refresh();
    };
    return inp;
  };
  const minIn = amountIn('minAmount', 'csv-min', 'min', 'smallest amount to show — blank = no lower limit');
  const maxIn = amountIn('maxAmount', 'csv-max', 'max', 'largest amount to show — blank = no upper limit');
  const fromIn = h('input', { class: C.input, attrs: { type: 'date', value: f.dateFrom, 'aria-label': 'from date' } }) as HTMLInputElement;
  const toIn = h('input', { class: C.input, attrs: { type: 'date', value: f.dateTo, 'aria-label': 'to date' } }) as HTMLInputElement;
  fromIn.onchange = () => { f.dateFrom = fromIn.value; ui.page = 0; refresh(); };
  toIn.onchange = () => { f.dateTo = toIn.value; ui.page = 0; refresh(); };
  const dirSel = h('select', { class: C.input, title: 'show income, expense or all transactions' },
    h('option', { text: 'All', attrs: { value: 'all' } }),
    h('option', { text: 'Income', attrs: { value: 'income' } }),
    h('option', { text: 'Expense', attrs: { value: 'expense' } }),
  ) as HTMLSelectElement;
  dirSel.value = f.direction;
  dirSel.onchange = () => { f.direction = dirSel.value as CsvFilter['direction']; ui.page = 0; refresh(); };

  const uncCb = h('input', { attrs: { type: 'checkbox', checked: f.onlyUncategorized ? 'checked' : null } }) as HTMLInputElement;
  uncCb.checked = f.onlyUncategorized;
  uncCb.onchange = () => { f.onlyUncategorized = uncCb.checked; ui.page = 0; refresh(); };

  // ---- category multi-select ----
  const allTags: string[] = [...state.settings.categories.map((c) => c.tag), UNCAT];
  const toggleCat = (tag: string) => {
    f.selectedCats = f.selectedCats.includes(tag)
      ? f.selectedCats.filter((x) => x !== tag)
      : [...f.selectedCats, tag];
    ui.page = 0;
    refresh();
  };
  const catOptions = allTags.map((tag) => {
    const on = f.selectedCats.includes(tag);
    const cb = h('input', { attrs: { type: 'checkbox', checked: on ? 'checked' : null } }) as HTMLInputElement;
    cb.checked = on;
    cb.onchange = () => toggleCat(tag);
    const dot = h('span', { class: C.dot });
    dot.style.background = categoryColor(tag);
    return h('label', { class: cx(C.chipBase, C.chipSm, on ? C.chipOn : C.chipNeutral) }, cb, dot, tag);
  });
  const catPicker = h('details', { class: 'group relative', attrs: { open: ui.pickerOpen ? 'open' : null } },
    h('summary', { class: 'flex cursor-pointer list-none items-center gap-1.5 border border-border bg-card px-3 py-1.5 transition-colors select-none hover:border-input [&::-webkit-details-marker]:hidden group-open:border-primary group-open:ring-2 group-open:ring-accent-soft' },
      Ic(Tags, 'size-4 text-muted-foreground'),
      h('span', { text: f.selectedCats.length === 0 ? 'All categories' : `${f.selectedCats.length} selected` }),
      f.selectedCats.length > 0 ? h('span', { class: 'bg-primary px-1.5 py-px text-[11px] text-primary-foreground', text: String(f.selectedCats.length) }) : null,
      Ic(ChevronDown, 'size-3.5 text-muted-foreground transition-transform group-open:rotate-180')),
    h('div', { class: 'absolute top-full left-0 z-45 mt-1.5 flex w-max max-w-[620px] flex-wrap gap-1.5 border border-border bg-card p-2.5 shadow-card' },
      ...catOptions,
      h('button', {
        class: C.link, text: 'clear selection',
        onclick: (e: MouseEvent) => { e.preventDefault(); f.selectedCats = []; ui.page = 0; refresh(); },
      })),
  );
  catPicker.addEventListener('toggle', () => { ui.pickerOpen = catPicker.open; });

  const resetBtn = h('button', {
    class: cx(C.link, 'inline-flex items-center gap-1'),
    onclick: () => {
      Object.assign(state.csvFilter, defaultCsvFilter());
      ui.page = 0;
      emit();
    },
  }, Ic(RotateCcw, 'size-3'), 'reset');

  const csvDateField = field('Date range', CalendarRange, fromIn, '→', toIn);
  csvDateField.classList.add('col-span-2');
  container.appendChild(h('div', { class: cx(C.card, 'mb-3 px-3.5 py-3') },
    h('div', { class: 'flex flex-wrap items-center gap-2' }, searchWrap, dirSel),
    h('div', { class: 'my-3 border-t border-dashed border-border' }),
    h('div', { class: 'grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] items-start gap-x-5 gap-y-3.5' },
      field('Amount', Banknote, minIn, '–', maxIn),
      csvDateField,
      field('Categories', Tags, catPicker),
      field('Options', ListFilter,
        h('label', { class: cx(C.chipBase, C.chipSm, f.onlyUncategorized ? C.chipOn : C.chipNeutral) }, uncCb, 'Uncategorized only'),
        resetBtn),
    ),
  ));

  // ---- table ----
  const categoryOf = (tx: Tx) => matchTx(tx, state.settings);
  const filtered = filterTxs(state.txs, f, categoryOf, UNCAT);
  filtered.sort((a, b) => {
    const dir = ui.sortDir;
    if (ui.sortKey === 'date') return dir * (a.bookingDate.localeCompare(b.bookingDate) || a.ref.localeCompare(b.ref));
    if (ui.sortKey === 'amount') return dir * (txAmount(a) - txAmount(b));
    return dir * a.text.localeCompare(b.text);
  });
  const size = ui.pageSize === 0 ? Math.max(1, filtered.length) : ui.pageSize;
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  if (ui.page >= pages) ui.page = pages - 1;
  const start = ui.page * size;
  const pageRows = filtered.slice(start, start + size);

  let sumIn = 0, sumOut = 0;
  for (const t of filtered) { sumIn += t.credit; sumOut += t.debit; }

  const table = h('table', { class: 'min-w-full border-collapse text-xs', style: { tableLayout: 'fixed' } });
  const colEls = COLS.map((c) => h('col', { style: { width: `${colW[c.key]}px` } }));
  table.appendChild(h('colgroup', {}, ...colEls));
  const syncTableW = () => {
    table.style.width = `${COLS.reduce((s, c) => s + colW[c.key], 0)}px`;
  };
  syncTableW();

  const headRow = h('tr');
  COLS.forEach((c, ci) => {
    const th = h('th', {
      class: cx(C.th, 'relative overflow-hidden text-ellipsis', c.num && C.num,
        c.sort && 'cursor-pointer select-none hover:text-foreground',
        c.sort && ui.sortKey === c.sort && 'text-foreground'),
      title: c.de ? `CSV column: ${c.de}` : 'assigned by the category rules (Categories tab)',
    });
    if (c.sort) {
      const key = c.sort;
      th.appendChild(h('span', { class: 'inline-flex items-center gap-1' }, c.label,
        ui.sortKey === key ? Ic(ui.sortDir === 1 ? ChevronUp : ChevronDown, 'size-3') : null));
      th.onclick = () => {
        if (justDragged) return; // ignore the click that ends a resize drag
        if (ui.sortKey === key) ui.sortDir = ui.sortDir === 1 ? -1 : 1;
        else { ui.sortKey = key; ui.sortDir = key === 'text' ? 1 : -1; }
        refresh();
      };
    } else {
      th.textContent = c.label;
    }
    th.appendChild(resizer(c, colEls[ci], syncTableW));
    headRow.appendChild(th);
  });
  table.appendChild(h('thead', {}, headRow));

  const tbody = h('tbody');
  for (const [ri, t] of pageRows.entries()) {
    const catTag = categoryOf(t);
    // zebra striping: every second row carries the alternating tint
    const tr = h('tr', { class: cx('hover:bg-muted/40', ri % 2 === 1 && 'bg-zebra') });
    tr.appendChild(h('td', { class: cx(C.td, CELL, C.num, C.mono), text: dmy(t.bookingDate) }));
    tr.appendChild(h('td', { class: cx(C.td, CELL, C.num, C.mono, C.muted), text: dmy(t.valueDate) }));
    tr.appendChild(h('td', { class: cx(C.td, CELL, C.mono, C.muted), text: t.ref, title: t.ref }));
    const td = h('td', { class: cx(C.td, CELL), title: t.text, text: '' });
    td.innerHTML = highlight(t.text, f.fuzzy ? '' : f.text, f.caseSensitive);
    tr.appendChild(td);
    tr.appendChild(h('td', { class: cx(C.td, CELL) }, (() => {
      const chipColor = categoryColor(catTag);
      return h('button', {
        // text color is picked from the category color, so pale fills never end up with white text
        class: 'max-w-full cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap border-0 px-2.5 py-0.5 text-[11px] font-medium transition-[filter] hover:brightness-110',
        style: { background: chipColor, color: readableOn(chipColor) },
        title: `${catTag} · click to filter by this category (again to remove)`,
        onclick: () => toggleCat(catTag),
      }, catTag);
    })()));
    tr.appendChild(h('td', { class: cx(C.td, CELL, C.num, 'text-success'), text: t.credit > 0 ? num2(t.credit) : '' }));
    tr.appendChild(h('td', { class: cx(C.td, CELL, C.num, 'text-danger'), text: t.debit > 0 ? `−${num2(t.debit)}` : '' }));
    tr.title = `IBAN ${t.ibanDisplay || t.iban} · ${t.file} row ${t.row}`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  attachCellSelect(tbody, (ci) => COLS[ci]?.label ?? 'Column');
  container.appendChild(h('div', { class: cx(C.scroll, 'max-h-[66vh] overflow-y-auto') }, table));

  // ---- rows per page + pager ----
  const sizeSel = h('select', {
    class: cx(C.input, 'px-2 py-1'), title: 'number of rows shown per page',
    onchange: () => {
      ui.pageSize = Number(sizeSel.value);
      try {
        localStorage.setItem(PGKEY, String(ui.pageSize));
      } catch { /* ignore */ }
      ui.page = 0;
      refresh();
    },
  }, ...PAGE_SIZES.map((s) => h('option', { text: s === 0 ? 'All' : String(s), attrs: { value: String(s) } })));
  sizeSel.value = String(ui.pageSize);

  const pgBtn = (icon: IconNode, title: string, target: number, disabled: boolean) =>
    h('button', {
      class: cx('grid size-7 place-items-center border transition-colors select-none',
        disabled ? 'cursor-default border-border opacity-35' : 'cursor-pointer border-border bg-card text-foreground hover:border-input hover:bg-muted/50'),
      attrs: { disabled: disabled ? '' : null },
      title,
      onclick: () => {
        if (!disabled) { ui.page = Math.min(Math.max(0, target), pages - 1); refresh(); }
      },
    }, Ic(icon, 'size-3.5'));

  const shownFrom = filtered.length === 0 ? 0 : start + 1;
  const shownTo = Math.min(start + size, filtered.length);
  container.appendChild(h('div', { class: 'mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]' },
    h('span', { class: C.muted, text: `${num0(filtered.length)} of ${num0(state.txs.length)} transactions · showing ${num0(shownFrom)}–${num0(shownTo)}` }),
    h('span', {}, 'Σ in ', h('b', { class: 'text-success', text: num2(sumIn) }), ' · ', 'Σ out ', h('b', { class: 'text-danger', text: num2(sumOut) })),
    h('div', { class: 'ml-auto flex flex-wrap items-center gap-2' },
      h('span', { class: C.label, text: 'per page' }), sizeSel,
      h('div', { class: 'flex items-center gap-1' },
        pgBtn(ChevronsLeft, 'First page', 0, ui.page === 0),
        pgBtn(ChevronLeft, 'Previous page', ui.page - 1, ui.page === 0),
        h('span', { class: 'min-w-[96px] text-center text-[12.5px] tabular-nums', text: `Page ${ui.page + 1} / ${pages}` }),
        pgBtn(ChevronRight, 'Next page', ui.page + 1, ui.page >= pages - 1),
        pgBtn(ChevronsRight, 'Last page', pages - 1, ui.page >= pages - 1),
      ),
    ),
  ));

  function openPrintDialog(): void {
    if (filtered.length === 0) {
      toast('Nothing to print — no transactions match the filter', 'err');
      return;
    }
    /** gray out a column chip that a merge option folds into another column */
    const enable = (ch: { el: HTMLElement; cb: HTMLInputElement }, on: boolean): void => {
      ch.cb.disabled = !on;
      if (!on) ch.cb.checked = false;
      ch.el.classList.toggle('opacity-50', !on);
    };
    const checks = COLS.map((c) => printCheck(c.label, printOpts.cols.includes(c.key), c.de ? `CSV column: ${c.de}` : 'assigned by the category rules (Categories tab)'));
    const [dateChk, valueChk, refChk, textChk, catChk, creditChk, debitChk] = checks;
    const mergedChk = printCheck('Merged', printOpts.merged, 'one Amount column instead of Credit + Debit: signed + / −');
    const boldIncomeChk = printCheck('Bold income', printOpts.boldIncome, 'print income (positive amounts) in bold');
    const totalsChk = printCheck('Show totals row', printOpts.totals, 'the “total” row with the Σ amounts at the end of the table');
    const catMergeChk = printCheck('Merge Category into Description', printOpts.catDesc, 'prints “Category — text” and leaves out the Category column');
    const datesMergeChk = printCheck('Merge Booking + Value date', printOpts.datesMerged, 'one date column; valuta on a second line when the dates differ');
    const scopeAll = printRadio(`All filtered rows (${num0(filtered.length)})`, 'csv-print-scope', true);
    const scopePage = printRadio(`Current page only (${num0(pageRows.length)})`, 'csv-print-scope', false);
    const sortAs = printRadio('As shown', 'csv-print-sort', printOpts.sort === 'as', 'keep the current table sort order');
    const sortNew = printRadio('Newest first', 'csv-print-sort', printOpts.sort === 'newest', 'booking date descending');
    const sortOld = printRadio('Oldest first', 'csv-print-sort', printOpts.sort === 'oldest', 'booking date ascending');
    const pageNumsChk = printCheck('Show page numbers', printOpts.pageNums, '“n / total” centered at the bottom of each page');
    const landscapeChk = printCheck('Landscape', printOpts.landscape, 'wide tables fit better on landscape pages');
    const date = printDateInput();
    const font = fontControls();
    const syncAmounts = (): void => {
      enable(creditChk, !mergedChk.cb.checked);
      enable(debitChk, !mergedChk.cb.checked);
    };
    const syncMerges = (): void => {
      enable(catChk, !catMergeChk.cb.checked);
      enable(valueChk, !datesMergeChk.cb.checked);
    };
    mergedChk.cb.onchange = creditChk.cb.onchange = debitChk.cb.onchange = syncAmounts;
    catMergeChk.cb.onchange = datesMergeChk.cb.onchange = syncMerges;
    syncAmounts();
    syncMerges();
    const controls = h('div', { class: 'flex flex-col gap-2' },
      field('Columns', FileSpreadsheet, dateChk.el, valueChk.el, refChk.el, textChk.el, catChk.el),
      field('Amounts', Banknote, creditChk.el, debitChk.el, mergedChk.el, boldIncomeChk.el, totalsChk.el),
      field('Description', Tags, catMergeChk.el),
      field('Dates', CalendarRange, datesMergeChk.el),
      field('Rows', ListFilter, scopeAll.el, scopePage.el),
      field('Sort by booking date', ArrowUpDown, sortAs.el, sortNew.el, sortOld.el),
      field('Page', Printer, landscapeChk.el, pageNumsChk.el, date.el),
      field('Font', Type, font.el),
      h('p', { class: cx(C.muted, 'text-[12.5px]') },
        'Printer-friendly output on white: black ink only; a merge replaces the two separate columns.'),
    );
    openPrintModal('Print transaction table', controls, () => {
      const merged = mergedChk.cb.checked;
      const catDesc = catMergeChk.cb.checked;
      const datesMerged = datesMergeChk.cb.checked;
      const boldIncome = boldIncomeChk.cb.checked;
      const showTotals = totalsChk.cb.checked;
      const cellOf = (c: ColDef, t: Tx): string => {
        switch (c.key) {
          case 'date': return dmy(t.bookingDate);
          case 'value': return dmy(t.valueDate);
          case 'ref': return t.ref;
          case 'text': return t.text;
          case 'cat': return categoryOf(t);
          case 'credit': return t.credit > 0 ? num2(t.credit) : '';
          case 'debit': return t.debit > 0 ? `−${num2(t.debit)}` : '';
        }
      };
      // columns in display order, honoring the merge options
      const spec: Array<{ col: CsvPrintColumn; cell: (t: Tx) => string }> = [];
      COLS.forEach((c, i) => {
        if (!checks[i].cb.checked) return;
        if (c.key === 'credit' || c.key === 'debit') return; // handled by the Amounts row
        if (c.key === 'cat' && catDesc) return; // folded into Description
        if (c.key === 'value' && datesMerged) return; // folded into Booking date
        if (c.key === 'date' && datesMerged) {
          spec.push({ col: { key: 'date', label: 'Date', nl: true }, cell: (t) => mergedDateCell(t.bookingDate, t.valueDate) });
          return;
        }
        if (c.key === 'text') {
          spec.push({
            col: { key: 'text', label: c.label, wrap: true },
            cell: (t) => (catDesc ? mergedDescCell(t.text, categoryOf(t)) : t.text),
          });
          return;
        }
        // dates print left-aligned, amounts right-aligned
        spec.push({ col: { key: c.key, label: c.label, num: c.key === 'date' || c.key === 'value' ? undefined : c.num }, cell: (t) => cellOf(c, t) });
      });
      if (merged) {
        spec.push({ col: { key: 'amount', label: 'Amount', num: true, boldPositive: boldIncome }, cell: (t) => mergedAmountCell(t.credit, t.debit) });
      } else {
        if (creditChk.cb.checked) spec.push({ col: { key: 'credit', label: 'Credit', num: true, boldPositive: boldIncome }, cell: (t) => (t.credit > 0 ? num2(t.credit) : '') });
        if (debitChk.cb.checked) spec.push({ col: { key: 'debit', label: 'Debit', num: true }, cell: (t) => (t.debit > 0 ? `−${num2(t.debit)}` : '') });
      }
      if (spec.length === 0) {
        toast('Select at least one column to print', 'err');
        return;
      }
      let rows: Tx[] = scopePage.rb.checked ? pageRows : filtered;
      const sort: 'as' | 'newest' | 'oldest' = sortNew.rb.checked ? 'newest' : sortOld.rb.checked ? 'oldest' : 'as';
      if (sort !== 'as') {
        rows = [...rows].sort((a, b) => (sort === 'newest' ? b.bookingDate.localeCompare(a.bookingDate) : a.bookingDate.localeCompare(b.bookingDate)));
      }
      let tin = 0;
      let tout = 0;
      for (const t of rows) {
        tin += t.credit;
        tout += t.debit;
      }
      const totals: Record<string, string> = {};
      if (showTotals) {
        if (spec.some((s) => s.col.key === 'credit')) totals.credit = num2(tin);
        if (spec.some((s) => s.col.key === 'debit')) totals.debit = `−${num2(tout)}`;
        if (spec.some((s) => s.col.key === 'amount')) totals.amount = mergedNetTotal(tin, tout);
      }
      const style = font.get();
      printOpts = {
        cols: spec.map((s) => s.col.key).filter((k): k is ColKey => COLS.some((c) => c.key === k)),
        merged,
        catDesc,
        datesMerged,
        sort,
        pageNums: pageNumsChk.cb.checked,
        landscape: landscapeChk.cb.checked,
        boldIncome,
        totals: showTotals,
      };
      try {
        localStorage.setItem(PRINT_OPTS_KEY, JSON.stringify(printOpts));
      } catch { /* ignore */ }
      savePrintStyle(style);
      // only lines about filters that are actually active — no scope/sort/settings meta clutter
      const meta: string[] = [
        f.text ? `Search: “${f.text}”${f.caseSensitive ? ' · case-sensitive' : ''}${f.fuzzy ? ' · fuzzy' : ''}` : null,
        f.minAmount || f.maxAmount ? `Amount: ${f.minAmount || '0'} – ${f.maxAmount || 'open'}` : null,
        f.dateFrom || f.dateTo ? `Date range: ${f.dateFrom ? dmy(f.dateFrom) : '…'} → ${f.dateTo ? dmy(f.dateTo) : '…'}` : null,
        f.direction !== 'all' ? `Direction: ${f.direction}` : null,
        f.onlyUncategorized ? 'Uncategorized only' : null,
        f.selectedCats.length > 0 ? `Categories: ${f.selectedCats.join(', ')}` : null,
      ].filter((s): s is string => s !== null);
      printHtml(buildCsvPrintDoc({
        title: 'Transaction list',
        meta,
        printDate: date.get(),
        columns: spec.map((s) => s.col),
        rows: rows.map((t) => spec.map((s) => s.cell(t))),
        totals,
      }, { landscape: landscapeChk.cb.checked, pageNumbers: pageNumsChk.cb.checked, font: style.font, sizePt: style.sizePt }));
    });
  }

  // the header print button opens this dialog while this tab is active
  setTabPrintHandler(() => openPrintDialog());

  function refresh(): void {
    emit();
  }
}
