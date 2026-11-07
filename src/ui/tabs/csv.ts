import { ArrowUpDown, Banknote, CalendarRange, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ChevronUp, FileSpreadsheet, ListFilter, Printer, RotateCcw, Search, Tags, Type, Wand2 } from 'lucide';
import type { IconNode } from 'lucide';
import type { Tx } from '../../types';
import { financeRows, transactionTools } from '../financeTools';
import { allocationRows } from '../../finance/reporting';
import { calculateCashBalances, cashOpeningBalance, compareTransactionOrder, isCashTransfer, matchesTransactionSource } from '../../cash';
import { calculateCombinedBalances } from '../../balanceOverview';
import { renderCash } from './cash';
import { bankAccountKey, calculateAccountBalances, calculatedAccountEndings, groupBankAccounts, loadAccountOpeningBalances, removeAccountOpeningBalance, saveAccountOpeningBalance } from '../../bankBalances';
import { state, emit, removeFile } from '../../state';
import { openMapperManager } from '../uploadFlow';
import { csvPicker, noCsvCard } from '../addCsv';
import { defaultCsvFilter, filterTxs, highlight, txAmount, type CsvFilter } from '../search';
import { matchTx, UNCAT } from '../../categories/engine';
import { C, clear, cx, dmy, field, h, num0, num2, readableOn, sourceGroup, toast } from '../util';
import { attachCellSelect, clearColumnSelect } from '../cellSelect';
import { attachDragPan } from '../dragScroll';
import { colResizeHandle } from '../colResize';
import { Ic } from '../icons';
import { downloadCsv, exportAmount, fileStamp, setTabExportHandler } from '../exportCsv';
import { buildCsvPrintDoc, fontControls, mergedAmountCell, mergedDateCell, mergedDescCell, mergedNetTotal, openPrintModal, printCheck, printDateInput, printHtml, printRadio, savePrintStyle, setTabPrintHandler, type CsvPrintColumn } from '../print';

type SortKey = 'date' | 'amount' | 'text';
interface CsvTabState {
  sortKey: SortKey;
  sortDir: 1 | -1;
  page: number;
  pickerOpen: boolean;
  pageSize: number;
  /** column visibility (persisted): Value date and Order no. default off, amounts default merged */
  showValue: boolean;
  showRef: boolean;
  merged: boolean;
  showBalance: boolean;
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
const COLVIS_KEY = 'banking.csvCols';
function loadColVis(): Pick<CsvTabState, 'showValue' | 'showRef' | 'merged' | 'showBalance'> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLVIS_KEY) ?? 'null') as Record<string, unknown> | null;
    if (raw && typeof raw === 'object') {
      return { showValue: raw.showValue === true, showRef: raw.showRef === true, merged: raw.merged !== false, showBalance: raw.showBalance !== false };
    }
  } catch { /* ignore */ }
  return { showValue: false, showRef: false, merged: true, showBalance: true };
}
function saveColVis(): void {
  try {
    localStorage.setItem(COLVIS_KEY, JSON.stringify({ showValue: ui.showValue, showRef: ui.showRef, merged: ui.merged, showBalance: ui.showBalance }));
  } catch { /* ignore */ }
}
const ui: CsvTabState = { sortKey: 'date', sortDir: -1, page: 0, pickerOpen: false, pageSize: loadPageSize(), ...loadColVis() };
let cashToolsOpen: boolean | null = null;
let accountBalancesOpen: boolean | null = null;

// ---- resizable columns ----
type ColKey = 'date' | 'value' | 'ref' | 'text' | 'cat' | 'credit' | 'debit' | 'amount' | 'balance';
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
/** virtual display column that replaces Credit + Debit when the amounts are merged */
const AMOUNT_COL: ColDef = { key: 'amount', label: 'Amount', def: 130, sort: 'amount', num: true };
const BALANCE_COL: ColDef = { key: 'balance', label: 'Total balance', def: 150, num: true };
const PRINT_COLS: ColDef[] = [...COLS, BALANCE_COL];
/** every key that can own a width — the print dialog still offers only the seven real CSV columns */
const ALL_COLS: ColDef[] = [...COLS, AMOUNT_COL, BALANCE_COL];
const MIN_COL_W = 64;
const COLW_KEY = 'banking.csvColW';
/** cell classes for clipping long content with an ellipsis */
const CELL = 'overflow-hidden text-ellipsis';

/** the columns currently shown, in table order */
function shownCols(balanceLabel = BALANCE_COL.label): ColDef[] {
  return [
    COLS[0],
    ...(ui.showValue ? [COLS[1]] : []),
    ...(ui.showRef ? [COLS[2]] : []),
    COLS[3],
    COLS[4],
    ...(ui.merged ? [AMOUNT_COL] : [COLS[5], COLS[6]]),
    ...(ui.showBalance ? [{ ...BALANCE_COL, label: balanceLabel }] : []),
  ];
}

function loadColW(): Record<ColKey, number> {
  let saved: Record<string, unknown> = {};
  try {
    saved = JSON.parse(localStorage.getItem(COLW_KEY) ?? '{}') as Record<string, unknown>;
  } catch { saved = {}; }
  const out = {} as Record<ColKey, number>;
  for (const c of ALL_COLS) {
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
  const cols = raw.filter((k): k is ColKey => typeof k === 'string' && PRINT_COLS.some((c) => c.key === k));
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
function resizer(c: ColDef, cols: HTMLTableColElement[], sync: () => void): HTMLElement {
  return colResizeHandle({
    width: () => colW[c.key],
    apply: (px) => {
      colW[c.key] = px === 0 ? c.def : px;
      for (const col of cols) col.style.width = `${colW[c.key]}px`;
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
  const allTxs = financeRows();
  const bankAccounts = groupBankAccounts(state.txs);
  const accountOpenings = loadAccountOpeningBalances();
  const transactionBalances = calculateAccountBalances(state.txs, accountOpenings);
  const accountEndings = calculatedAccountEndings(bankAccounts, accountOpenings);
  const cashBalances = calculateCashBalances(state.txs, state.cashEntries, state.settings, cashOpeningBalance());
  const sourceFilter: CsvFilter['source'] = f.source === 'cash' || f.source === 'bank' ? f.source : 'both';
  f.source = sourceFilter;
  // All mode: one combined cash + bank total after each row (transfers net to zero)
  const combinedBalances = calculateCombinedBalances(state.txs, state.cashEntries, state.settings, cashOpeningBalance(), accountOpenings);
  const hasUnanchored = bankAccounts.some((a) => !accountOpenings[a.key]);
  const balanceLabel = sourceFilter === 'cash' ? 'Cash balance' : sourceFilter === 'bank' ? 'Bank balance' : 'Total balance';
  const displayPrintCols = PRINT_COLS.map((column) => column.key === 'balance' ? { ...column, label: balanceLabel } : column);
  const usesCashBalance = (tx: Tx): boolean => sourceFilter === 'cash'
    || Boolean(tx.cashEntryId)
    || (sourceFilter === 'both' && isCashTransfer(tx, state.settings));
  const balanceFor = (tx: Tx): number | undefined => sourceFilter === 'both'
    ? combinedBalances.get(tx.id)
    : usesCashBalance(tx) ? cashBalances.get(tx.id) : transactionBalances.get(tx.id);
  const balanceTitleFor = (tx: Tx): string => {
    if (sourceFilter === 'both') return hasUnanchored
      ? 'Combined cash + bank balance after this row; cash transfers only move money between wallet and bank. Accounts without an opening balance contribute their net movement.'
      : 'Combined cash + bank balance after this row; cash transfers only move money between wallet and bank.';
    if (usesCashBalance(tx)) return tx.cashEntryId
      ? 'Cash balance after this cash entry; includes the opening cash balance and all wallet movements.'
      : 'Cash balance after this bank cash transfer; includes the opening cash balance and all wallet movements.';
    const opening = accountOpenings[bankAccountKey(tx)];
    return !opening
      ? 'Net movement since the first imported transaction; set an opening balance for the actual bank balance'
      : `Balance after this transaction; opening balance date ${dmy(opening.date)}`;
  };

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

  // Keep cash management on the unified Transactions page. The cash-only ledger
  // remains available in this expandable section, while all bank and cash rows
  // together are shown in the shared table below.
  const noCsvLoaded = state.files.length === 0;
  if (noCsvLoaded) container.appendChild(noCsvCard());
  const cashToolsBody = h('div', { class: 'mt-2' });
  renderCash(cashToolsBody);
  const cashTools = h('details', {
    class: cx(C.card, 'mb-3 px-3.5 py-2.5'),
    attrs: { open: (cashToolsOpen ?? noCsvLoaded) ? 'open' : null },
  },
    h('summary', { class: 'cursor-pointer select-none text-sm font-semibold' },
      Ic(Banknote, 'mr-1.5 inline size-4'), 'Cash balance & entries'),
    cashToolsBody);
  cashTools.addEventListener('toggle', () => { cashToolsOpen = cashTools.open; });
  container.appendChild(cashTools);

  // With neither bank nor cash activity, the cash section still permits setup
  // and entry creation; the transaction table itself has nothing to show yet.
  if (noCsvLoaded && state.cashEntries.length === 0) return;

  if (bankAccounts.length > 0) {
    const accountCards = bankAccounts.map((account) => {
      const opening = accountOpenings[account.key];
      const dated = account.txs.map((tx) => tx.bookingDate || tx.valueDate).filter(Boolean).sort();
      const firstDate = dated[0] ?? new Date().toISOString().slice(0, 10);
      const dateInput = h('input', { class: C.input, attrs: { type: 'date', value: opening?.date ?? firstDate, 'aria-label': `opening balance date for ${account.label}` } }) as HTMLInputElement;
      const amountInput = h('input', { class: cx(C.input, 'w-36'), attrs: { type: 'number', step: '0.01', placeholder: 'Opening balance', value: opening ? String(opening.amount) : '', 'aria-label': `opening balance for ${account.label}` } }) as HTMLInputElement;
      const ending = accountEndings.get(account.key);
      const result = opening
        ? ending
          ? `Calculated balance after ${dmy(ending.date)}: ${num2(ending.amount)}`
          : `Opening balance as of ${dmy(opening.date)}: ${num2(opening.amount)} (no dated transactions loaded)`
        : ending
          ? `Net movement since first imported transaction (not actual balance): ${num2(ending.amount)}`
          : 'No dated transactions available to calculate movement.';
      const form = h('form', { class: 'flex flex-wrap items-end gap-2.5 py-2.5' },
        h('div', { class: 'min-w-[170px] flex-1' },
          h('div', { class: 'text-[13px] font-semibold', text: account.label }),
          h('div', { class: cx(C.muted, 'mt-0.5 text-xs'), text: result })),
        h('label', { class: 'flex flex-col gap-1' }, h('span', { class: C.label, text: 'Balance before date' }), dateInput),
        h('label', { class: 'flex flex-col gap-1' }, h('span', { class: C.label, text: 'Opening balance' }), amountInput),
        h('button', { class: C.btn, attrs: { type: 'submit' }, text: opening ? 'Save' : 'Set balance' }),
        opening ? h('button', { class: C.linkDanger, attrs: { type: 'button' }, text: 'Clear', onclick: () => {
          removeAccountOpeningBalance(account.key);
          toast(`Opening balance cleared for ${account.label}`);
          emit();
        } }) : null);
      form.onsubmit = (event) => {
        event.preventDefault();
        const amount = Number(amountInput.value);
        if (!dateInput.value || amountInput.value.trim() === '' || !Number.isFinite(amount)) {
          toast('Enter a date and a valid opening balance', 'err');
          return;
        }
        try {
          saveAccountOpeningBalance(account.key, { date: dateInput.value, amount });
          // Showing the new balance is part of setting an opening balance; the
          // column may have been explicitly hidden before the account was configured.
          ui.showBalance = true;
          saveColVis();
          toast(`Opening balance saved for ${account.label}`);
          emit();
        } catch (error) { toast(`Could not save opening balance: ${String(error)}`, 'err'); }
      };
      return form;
    });
    const accountBalances = h('details', {
      class: cx(C.card, 'mb-3 px-3.5 py-3'),
      attrs: { open: (accountBalancesOpen ?? true) ? 'open' : null },
    },
    h('summary', { class: 'cursor-pointer select-none text-[14px] font-semibold' },
      Ic(Banknote, 'mr-1.5 inline size-4'), 'Account balances'),
    h('div', { class: 'mt-2' },
      h('p', { class: cx(C.muted, 'text-xs') }, 'For an actual bank balance, enter the account balance immediately before transactions booked on the selected date. Without an opening balance, the column still shows net movement from zero at the first imported transaction—not the actual bank balance.'),
      ...accountCards,
      bankAccounts.some((account) => account.key === 'account:unknown')
        ? h('p', { class: cx(C.chipWarn, 'mt-1 inline-block'), text: 'These CSV rows do not include an account identifier; they are grouped together as one unidentified account.' })
        : null));
    accountBalances.addEventListener('toggle', () => { accountBalancesOpen = accountBalances.open; });
    container.appendChild(accountBalances);
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

  // Cash | Bank | All segment (replaces the old Source dropdown — same f.source values)
  const sourceBtns = sourceGroup('csvsrc', sourceFilter, {
    cash: 'show manual entries plus imported rows marked as cash movements',
    bank: 'show imported bank rows only',
    all: 'show every row — bank transactions and cash activity (default)',
  }, (v) => { f.source = v; ui.page = 0; refresh(); });

  // ---- column visibility toggles (persisted; defaults: value date off, order no. off, merged on) ----
  const colTog = (fk: string, label: string, title: string, on: boolean, set: (v: boolean) => void): HTMLElement => {
    const cb = h('input', { dataset: { fk }, attrs: { type: 'checkbox', checked: on ? 'checked' : null } }) as HTMLInputElement;
    cb.checked = on;
    cb.onchange = () => { set(cb.checked); saveColVis(); ui.page = 0; refresh(); };
    return h('label', { class: cx(C.chipBase, C.chipSm, on ? C.chipOn : C.chipNeutral), title }, cb, label);
  };

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
      field('Source', Banknote, ...sourceBtns),
      field('Categories', Tags, catPicker),
      field('Columns', ListFilter,
        colTog('csv-col-value', 'Value date', 'show the Value date (Valuta) column', ui.showValue, (v) => { ui.showValue = v; }),
        colTog('csv-col-ref', 'Order no.', 'show the Order no. (Auftragsnummer) column', ui.showRef, (v) => { ui.showRef = v; }),
        colTog('csv-col-merge', 'Merge amounts', 'one signed Amount column instead of separate Credit and Debit columns', ui.merged, (v) => { ui.merged = v; }),
        colTog('csv-col-balance', balanceLabel, sourceFilter === 'both'
          ? 'show the combined cash + bank balance after each row'
          : `show the calculated ${sourceFilter} balance after each row`, ui.showBalance, (v) => { ui.showBalance = v; }),
        resetBtn),
    ),
  ));

  // ---- table ----
  const categoryOf = (tx: Tx) => matchTx(tx, state.settings);
  const filtered = filterTxs(allTxs, f, categoryOf,
    (tx, source) => matchesTransactionSource(tx, source, state.settings));
  filtered.sort((a, b) => {
    const dir = ui.sortDir;
    if (ui.sortKey === 'date') return dir * compareTransactionOrder(a, b);
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

  // ---- table ----
  // Header and body are two stacked tables sharing the same <col> widths: the header
  // box sticks at menu level while the body box owns the horizontal scroll (a single
  // table inside an overflow wrapper would trap the sticky header in that wrapper —
  // same pattern as the Spending matrix). The table never overspans the window: when
  // the shown columns need more room than there is, the body scrolls — scrollbar,
  // trackpad or grab-drag anywhere on it.
  // border-separate (not collapse): with collapse, browsers drop a sticky cell's
  // border once it detaches from the grid — the 2px header rule would vanish.
  const shown = shownCols(balanceLabel);
  const mkTable = (): { table: HTMLElement; colgroup: HTMLElement } => {
    const table = h('table', { class: 'border-separate border-spacing-0 text-xs cursor-grab', style: { tableLayout: 'fixed' } });
    const colgroup = h('colgroup');
    table.appendChild(colgroup);
    return { table, colgroup };
  };
  const head = mkTable();
  const body = mkTable();

  /** both tables must always occupy exactly the same width */
  const syncTableW = (): void => {
    const px = shown.reduce((s, c) => s + colW[c.key], 0);
    for (const t of [head.table, body.table]) {
      t.style.width = `${px}px`;
      t.style.minWidth = '100%';
    }
  };

  const headRow = h('tr');
  shown.forEach((c) => {
    const th = h('th', {
      class: cx(C.th, 'relative overflow-hidden text-ellipsis', c.num && C.num,
        c.sort && 'cursor-pointer select-none hover:text-foreground',
        c.sort && ui.sortKey === c.sort && 'text-foreground'),
      title: c.key === 'amount' ? 'Credit and Debit merged into one signed column'
        : c.key === 'balance' ? sourceFilter === 'cash'
          ? 'Running wallet balance after each cash entry or marked bank cash transfer'
          : sourceFilter === 'bank'
            ? 'Bank account balance when an opening balance is set; otherwise net movement since the first imported transaction'
            : 'Combined cash + bank total after each row; cash transfers leave it unchanged'
        : c.de ? `CSV column: ${c.de}` : 'assigned by the category rules (Categories tab)',
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
    const cols = [h('col'), h('col')];
    for (const col of cols) col.style.width = `${colW[c.key]}px`;
    head.colgroup.appendChild(cols[0]);
    body.colgroup.appendChild(cols[1]);
    th.appendChild(resizer(c, cols, syncTableW));
    headRow.appendChild(th);
  });
  head.table.appendChild(h('thead', {}, headRow));

  const tbody = h('tbody');
  for (const [ri, t] of pageRows.entries()) {
    const catTag = categoryOf(t);
    // zebra striping: every second row carries the alternating tint
    const tr = h('tr', { class: cx('hover:bg-muted/40', ri % 2 === 1 && 'bg-zebra') });
    for (const c of shown) {
      switch (c.key) {
        case 'date':
          tr.appendChild(h('td', { class: cx(C.td, CELL, C.num, C.mono), text: dmy(t.bookingDate) }));
          break;
        case 'value':
          tr.appendChild(h('td', { class: cx(C.td, CELL, C.num, C.mono, C.muted), text: dmy(t.valueDate) }));
          break;
        case 'ref':
          tr.appendChild(h('td', { class: cx(C.td, CELL, C.mono, C.muted), text: t.ref, title: t.ref }));
          break;
        case 'text': {
          const td = h('td', { class: cx(C.td, CELL), title: t.text, text: '' });
          td.innerHTML = highlight(t.text, f.fuzzy ? '' : f.text, f.caseSensitive);
          td.appendChild(h('span', { class: cx(C.badgeMuted, 'ml-1'), text: t.cashEntryId ? 'Cash' : isCashTransfer(t, state.settings) ? 'Cash transfer' : 'Bank' }));
          if (t.internalTransfer) td.append(h('span', { class: C.chipWarn }, 'Internal transfer · excluded'));
          if (t.categoryOverrides?.[state.activeSettingsName]) td.append(h('span', { class: C.badgeMuted }, 'Manual category'));
          const parts = state.finance.bundles[state.activeSettingsName]?.annotations[t.id]?.parts;
          if (parts) td.append(h('details', {}, h('summary', { class: 'cursor-pointer text-xs' }, `Split (${parts.length} parts)`),
            ...parts.map((p) => h('div', { class: 'text-xs whitespace-normal' }, `${p.category} · ${num2(p.amount)} · ${p.note}`))));
          td.append(transactionTools(t));
          tr.appendChild(td);
          break;
        }
        case 'cat':
          tr.appendChild(h('td', { class: cx(C.td, CELL) }, (() => {
            const chipColor = categoryColor(catTag);
            const cashMovement = state.settings.categories.find((cat) => cat.tag === catTag)?.cashMovement;
            return h('button', {
              // text color is picked from the category color, so pale fills never end up with white text
              class: 'max-w-full cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap border-0 px-2.5 py-0.5 text-[11px] font-medium transition-[filter] hover:brightness-110',
              style: { background: chipColor, color: readableOn(chipColor) },
              title: `${catTag}${cashMovement ? ` · cash ${cashMovement}` : ''} · click to filter by this category (again to remove)`,
              onclick: () => toggleCat(catTag),
            }, catTag, cashMovement ? h('span', { class: 'ml-1 text-[9px] font-bold uppercase', text: cashMovement === 'withdrawal' ? 'cash in' : 'cash out' }) : null);
          })()));
          break;
        case 'credit':
          tr.appendChild(h('td', { class: cx(C.td, CELL, C.num, 'text-success'), text: t.credit > 0 ? num2(t.credit) : '' }));
          break;
        case 'debit':
          tr.appendChild(h('td', { class: cx(C.td, CELL, C.num, 'text-danger'), text: t.debit > 0 ? `−${num2(t.debit)}` : '' }));
          break;
        case 'amount': {
          // one signed column: income with a +, expense with a −, colored as before
          const v = t.credit > 0 ? `+${num2(t.credit)}` : t.debit > 0 ? `−${num2(t.debit)}` : '';
          tr.appendChild(h('td', { class: cx(C.td, CELL, C.num, t.credit > 0 && 'text-success', t.debit > 0 && 'text-danger'), text: v }));
          break;
        }
        case 'balance': {
          const value = balanceFor(t);
          const isCashBalance = usesCashBalance(t);
          const opening = isCashBalance ? undefined : accountOpenings[bankAccountKey(t)];
          // in All mode the Δ marks a combined total that includes net-movement
          // accounts; in Bank mode it marks the unanchored account of that row
          const showDelta = sourceFilter === 'both' ? hasUnanchored : !isCashBalance && !opening;
          const title = balanceTitleFor(t);
          tr.appendChild(h('td', { class: cx(C.td, CELL, C.num, value !== undefined && value < 0 && 'text-danger', value === undefined && C.muted), title },
            value === undefined ? '—' : h('span', {}, showDelta ? h('span', { class: C.muted, text: 'Δ ' }) : null, num2(value))));
          break;
        }
      }
    }
    tr.title = t.cashEntryId ? 'Manually entered cash transaction' : `IBAN ${t.ibanDisplay || t.iban} · ${t.file} row ${t.row}`;
    tbody.appendChild(tr);
  }
  body.table.appendChild(tbody);
  syncTableW();
  attachCellSelect(tbody, (ci) => shown[ci]?.label ?? 'Column');

  const headBox = h('div', { class: cx(C.card, 'sticky top-[var(--appbar-h)] z-20 overflow-x-hidden border-b-0') }, head.table);
  const bodyBox = h('div', { class: cx(C.card, 'overflow-x-auto border-t-0') }, body.table);
  bodyBox.addEventListener('scroll', () => { headBox.scrollLeft = bodyBox.scrollLeft; }, { passive: true });
  // grab-and-slide panning over the whole table (single clicks still select a
  // cell's text — only the click that ends a real drag is swallowed; controls
  // like the category chips keep their own behavior)
  attachDragPan(bodyBox);
  attachDragPan(bodyBox, headBox);
  // both boxes share one plain wrapper: the sticky header releases exactly at the
  // bottom of the table (its containing block), not only when the tab content ends
  const tableWrap = h('div', {}, headBox, bodyBox);
  container.appendChild(tableWrap);

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
    h('span', { class: C.muted, text: `${num0(filtered.length)} of ${num0(allTxs.length)} transactions · showing ${num0(shownFrom)}–${num0(shownTo)}` }),
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

  /** the CSV table as CSV: the columns exactly as displayed (one signed Amount
   *  column while merged), every filtered row in the current sort order — or just
   *  the current page when the dialog says so. Amounts are plain signed numbers,
   *  dates as displayed (dd.mm.yyyy). */
  function exportCsvTable(pageOnly: boolean, allocations = false): void {
    const originals = pageOnly ? pageRows : filtered;
    const originalIds = new Set(originals.map((t) => t.id));
    const source = allocations ? allocationRows(allTxs, state.finance, state.settings).filter((t) => originalIds.has(t.parentId ?? t.id)) : originals;
    const cell = (c: ColDef, t: Tx): string => {
      switch (c.key) {
        case 'date': return dmy(t.bookingDate);
        case 'value': return dmy(t.valueDate);
        case 'ref': return t.ref;
        case 'text': return t.text;
        case 'cat': return categoryOf(t);
        case 'credit': return t.credit > 0 ? exportAmount(t.credit) : '';
        case 'debit': return t.debit > 0 ? exportAmount(-t.debit) : '';
        case 'amount': return t.credit > 0 ? exportAmount(t.credit) : t.debit > 0 ? exportAmount(-t.debit) : '';
        case 'balance': {
          const value = balanceFor(t);
          return value === undefined ? '' : exportAmount(value);
        }
      }
    };
    const rows: string[][] = [[...(allocations ? ['Transaction ID', 'Parent ID', 'Row kind'] : []), ...shown.map((c) => c.label)]];
    for (const t of source) rows.push([...(allocations ? [t.id, t.parentId ?? '', t.parentId ? 'allocation' : 'original'] : []), ...shown.map((c) => cell(c, t))]);
    downloadCsv(`transactions-${fileStamp()}.csv`, rows);
    toast(`Exported ${num0(source.length)} transactions`);
  }

  /** The dialog the header export button opens: spells out exactly what the file
   *  would contain — row scope, order, columns and active filters — so nothing is
   *  downloaded unseen; 'Download CSV' confirms. */
  function openExportDialog(): void {
    if (filtered.length === 0) {
      toast('Nothing to export — no transactions match the filter', 'err');
      return;
    }
    const scopeAll = printRadio(`All filtered rows (${num0(filtered.length)})`, 'csv-export-scope', true, 'every row matching the current filters, not just this page');
    const scopePage = printRadio(`Current page only (${num0(pageRows.length)})`, 'csv-export-scope', false, 'just the rows of the page you are looking at');
    const allocations = printCheck('Allocation detail instead of original ledger rows', false, 'Splits replace parents; confirmed internal transfers are omitted. Includes transaction/parent IDs. Balance values apply only to original ledger rows.');
    const sortLabel = ui.sortKey === 'date' ? `Booking date — ${ui.sortDir === 1 ? 'oldest' : 'newest'} first`
      : ui.sortKey === 'amount' ? `Amount — ${ui.sortDir === 1 ? 'smallest' : 'largest'} first`
      : `Description — ${ui.sortDir === 1 ? 'A → Z' : 'Z → A'}`;
    // only lines about filters that are actually active (the print dialog lists the same)
    const filterLines = [
      f.text ? `Search: “${f.text}”${f.caseSensitive ? ' · case-sensitive' : ''}${f.fuzzy ? ' · fuzzy' : ''}` : null,
      f.minAmount || f.maxAmount ? `Amount: ${f.minAmount || '0'} – ${f.maxAmount || 'open'}` : null,
      f.dateFrom || f.dateTo ? `Date range: ${f.dateFrom ? dmy(f.dateFrom) : '…'} → ${f.dateTo ? dmy(f.dateTo) : '…'}` : null,
      f.direction !== 'all' ? `Direction: ${f.direction}` : null,
      sourceFilter !== 'both' ? `Source: ${sourceFilter === 'cash' ? 'Cash activity' : 'Bank transactions'}` : null,
      f.selectedCats.length > 0 ? `Categories: ${f.selectedCats.join(', ')}` : null,
    ].filter((s): s is string => s !== null);
    const pill = (t: string): HTMLElement => h('span', { class: 'border border-border bg-subtle px-2 py-0.5 text-xs', text: t });
    const controls = h('div', { class: 'flex flex-col gap-2.5' },
      field('Rows', ListFilter, scopeAll.el, scopePage.el),
      allocations.el,
      field('Order', ArrowUpDown, pill(sortLabel)),
      field('Columns', FileSpreadsheet, ...shown.map((c) => pill(c.label))),
      filterLines.length > 0 ? field('Active filters', Search, ...filterLines.map(pill)) : null,
      h('p', { class: cx(C.muted, 'text-[12.5px]') },
        'One line per row, comma-separated; amounts as plain signed numbers (1234.50 / -1234.50), dates dd.mm.yyyy, UTF-8 with BOM so Excel opens it cleanly.'));
    openPrintModal('Export transaction table as CSV', controls, () => exportCsvTable(scopePage.rb.checked, allocations.cb.checked), 'Download CSV');
  }

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
    const checks = displayPrintCols.map((c) => printCheck(c.label, printOpts.cols.includes(c.key), c.key === 'balance'
      ? sourceFilter === 'cash' ? 'cash balance after each wallet movement'
        : sourceFilter === 'bank' ? 'bank balance after each imported transaction'
          : 'combined cash + bank total after each row'
      : c.de ? `CSV column: ${c.de}` : 'assigned by the category rules (Categories tab)'));
    const [dateChk, valueChk, refChk, textChk, catChk, creditChk, debitChk, balanceChk] = checks;
    const mergedChk = printCheck('Merged', printOpts.merged, 'one Amount column instead of Credit + Debit: signed + / −');
    const boldIncomeChk = printCheck('Bold income', printOpts.boldIncome, 'print income (positive amounts) in bold');
    const totalsChk = printCheck('Show totals row', printOpts.totals, 'the “total” row with the Σ amounts at the end of the table');
    const catMergeChk = printCheck('Merge Category into Description', printOpts.catDesc, 'prints “Category — text” and leaves out the Category column');
    const datesMergeChk = printCheck('Merge Booking + Value date', printOpts.datesMerged, 'one date column; valuta on a second line when the dates differ');
    const scopeAll = printRadio(`All filtered rows (${num0(filtered.length)})`, 'csv-print-scope', true);
    const scopePage = printRadio(`Current page only (${num0(pageRows.length)})`, 'csv-print-scope', false);
    const allocations = printCheck('Allocation detail instead of original ledger rows', false, 'Split children replace original parents; confirmed internal transfers are omitted. Parent ID is included in descriptions. Balances belong only to original ledger rows.');
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
      field('Columns', FileSpreadsheet, dateChk.el, valueChk.el, refChk.el, textChk.el, catChk.el, balanceChk.el),
      field('Amounts', Banknote, creditChk.el, debitChk.el, mergedChk.el, boldIncomeChk.el, totalsChk.el),
      field('Description', Tags, catMergeChk.el),
      field('Dates', CalendarRange, datesMergeChk.el),
      field('Rows', ListFilter, scopeAll.el, scopePage.el),
      allocations.el,
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
          case 'amount': return mergedAmountCell(t.credit, t.debit);
          case 'balance': {
            const value = balanceFor(t);
            return value === undefined ? '' : num2(value);
          }
        }
      };
      // columns in display order, honoring the merge options
      const spec: Array<{ col: CsvPrintColumn; cell: (t: Tx) => string }> = [];
      displayPrintCols.forEach((c, i) => {
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
      if (allocations.cb.checked) {
        const ids = new Set(rows.map((t) => t.id));
        rows = allocationRows(allTxs, state.finance, state.settings).filter((t) => ids.has(t.parentId ?? t.id)).map((t) =>
          t.parentId ? { ...t, text: `[allocation of ${t.parentId}] ${t.text}` } : t);
      }
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
        cols: spec.map((s) => s.col.key).filter((k): k is ColKey => PRINT_COLS.some((c) => c.key === k)),
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
        sourceFilter !== 'both' ? `Source: ${sourceFilter === 'cash' ? 'Cash activity' : 'Bank transactions'}` : null,
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

  // the header print/export buttons open these dialogs while this tab is active
  setTabPrintHandler(() => openPrintDialog());
  setTabExportHandler(() => openExportDialog());

  function refresh(): void {
    emit();
  }
}
