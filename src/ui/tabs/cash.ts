import { Banknote, ChevronLeft, ChevronsLeft, ChevronsRight, ChevronRight, Pencil, Plus, Trash2 } from 'lucide';
import type { CashEntry, Tx } from '../../types';
import { state, emit, removeCashEntry, saveCashEntry } from '../../state';
import { movementOf, cashEntryTx, cashOpeningBalance, compareTransactionOrder, saveCashOpeningBalance } from '../../cash';
import { C, clear, cx, dmy, h, money, num2, toast } from '../util';
import { Ic } from '../icons';
import { attachDragPan } from '../dragScroll';

interface LedgerRow {
  id: string; date: string; label: string; category: string; note: string;
  delta: number; entry?: CashEntry; tx?: Tx;
}

let editing: CashEntry | null = null;
const CASH_PAGE_SIZES = [25, 50, 100, 250, 500, 0]; // 0 = all rows
const CASH_PAGE_SIZE_KEY = 'banking.cashPageSize';
let cashPage = 0;
function loadCashPageSize(): number {
  try {
    const value = Number(localStorage.getItem(CASH_PAGE_SIZE_KEY));
    if (CASH_PAGE_SIZES.includes(value)) return value;
  } catch { /* use default */ }
  return 250;
}
let cashPageSize = loadCashPageSize();

export function renderCash(container: HTMLElement): void {
  clear(container);
  const opening = cashOpeningBalance();
  const rows: LedgerRow[] = [];
  for (const tx of state.txs) {
    const movement = movementOf(tx, state.settings);
    if (!movement) continue;
    // A withdrawal reduces the bank balance and increases cash; a deposit does the reverse.
    const delta = tx.debit - tx.credit;
    rows.push({
      id: `bank:${tx.id}`, date: tx.bookingDate || tx.valueDate,
      label: movement.type === 'withdrawal' ? 'Cash withdrawal' : 'Cash deposit',
      category: movement.category.tag, note: tx.text, delta, tx,
    });
  }
  for (const entry of state.cashEntries) {
    rows.push({
      id: `cash:${entry.id}`, date: entry.date,
      label: entry.kind === 'expense' ? 'Cash expense' : entry.kind === 'income' ? 'Cash income' : 'Reconciliation adjustment',
      category: entry.kind === 'adjustment' ? 'Reconciliation' : entry.category || 'Uncategorized', note: entry.note,
      delta: entry.kind === 'expense' ? -entry.amount : entry.amount, entry,
    });
  }
  // Reconciliation adjustments are end-of-day corrections, so they follow all
  // ordinary movements on their date when computing the running balance.
  const transactionFor = (row: LedgerRow): Tx => row.tx ?? cashEntryTx(row.entry!);
  rows.sort((a, b) => compareTransactionOrder(transactionFor(a), transactionFor(b)));
  let balance = opening;
  const withBalance = rows.map((row) => { balance += row.delta; return { ...row, balance }; });
  const currentBalance = balance;

  const openingInput = h('input', { class: cx(C.input, 'w-32'), attrs: { type: 'number', step: '0.01', value: String(opening), 'aria-label': 'opening cash balance' } }) as HTMLInputElement;
  openingInput.onchange = () => {
    const value = Number(openingInput.value);
    if (!Number.isFinite(value)) { toast('Enter a valid opening balance', 'err'); return; }
    try { saveCashOpeningBalance(value); emit(); } catch (e) { toast(`Could not save opening balance: ${String(e)}`, 'err'); }
  };
  container.appendChild(h('div', { class: 'mb-3 flex flex-wrap items-center gap-3' },
    h('div', { class: cx(C.card, 'min-w-[190px] px-4 py-3') },
      h('div', { class: C.label, text: 'Cash balance' }),
      h('div', { class: cx('mt-1 text-xl font-bold tabular-nums', currentBalance < 0 ? 'text-danger' : 'text-foreground'), text: money(currentBalance) })),
    h('div', { class: cx(C.card, 'flex flex-wrap items-center gap-2 px-3.5 py-3') },
      h('label', { class: C.label, text: 'Opening balance' }), openingInput,
      h('span', { class: cx(C.muted, 'text-xs'), text: 'before the first listed cash movement' })),
  ));

  const corrections = state.cashEntries
    .filter((entry) => entry.kind === 'adjustment')
    .reduce((total, entry) => total + entry.amount, 0);
  container.appendChild(h('div', { class: cx(C.card, 'mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3.5 py-2.5 text-xs') },
    h('span', {},
      h('strong', { text: 'Cash reconciliation corrections: ' }),
      h('span', { class: cx(corrections < 0 ? 'text-danger' : 'text-success', 'font-semibold tabular-nums'), text: money(corrections) })),
    h('span', { class: C.muted, text: 'Included in the cash balance and in Spending under “Uncategorized Reconciliations”.' })));

  const reconcileDate = h('input', { class: C.input, attrs: { type: 'date', value: new Date().toISOString().slice(0, 10), 'aria-label': 'cash count date' } }) as HTMLInputElement;
  const countedAmount = h('input', { class: cx(C.input, 'w-32'), attrs: { type: 'number', min: '0', step: '0.01', placeholder: 'Counted cash', 'aria-label': 'counted cash balance' } }) as HTMLInputElement;
  const expectedAmount = h('strong', { class: 'tabular-nums' });
  const differenceAmount = h('strong', { class: 'tabular-nums' });
  const reconcileButton = h('button', { class: C.btnPrimary, attrs: { type: 'submit', disabled: '' }, text: 'Add adjustment' });
  const balanceAtDate = (dateValue: string): number => opening + rows
    .filter((row) => row.date <= dateValue)
    .reduce((sum, row) => sum + row.delta, 0);
  const updateReconciliationPreview = (): number | null => {
    const counted = countedAmount.value.trim() === '' ? NaN : Number(countedAmount.value);
    const expected = balanceAtDate(reconcileDate.value);
    const difference = counted - expected;
    expectedAmount.textContent = money(expected);
    expectedAmount.className = 'tabular-nums';
    differenceAmount.textContent = Number.isFinite(difference) ? `${difference > 0 ? '+' : ''}${money(difference)}` : '—';
    differenceAmount.className = cx('tabular-nums', Number.isFinite(difference) && (difference < 0 ? 'text-danger' : 'text-success'));
    reconcileButton.disabled = !reconcileDate.value || !Number.isFinite(counted) || counted < 0 || Math.abs(difference) < 0.005;
    return Number.isFinite(difference) ? difference : null;
  };
  reconcileDate.onchange = updateReconciliationPreview;
  countedAmount.oninput = updateReconciliationPreview;
  const reconciliationForm = h('form', { class: cx(C.card, 'mb-3 flex flex-wrap items-end gap-2.5 px-3.5 py-3') },
    h('div', { class: 'basis-full text-sm font-semibold' }, 'Reconcile cash'),
    h('label', { class: 'flex flex-col gap-1' }, h('span', { class: C.label, text: 'Count date' }), reconcileDate),
    h('label', { class: 'flex flex-col gap-1' }, h('span', { class: C.label, text: 'Cash counted' }), countedAmount),
    h('div', { class: 'flex flex-wrap items-center gap-x-4 gap-y-1 pb-1 text-[13px]' },
      h('span', {}, h('span', { class: C.muted, text: 'Ledger balance: ' }), expectedAmount),
      h('span', {}, h('span', { class: C.muted, text: 'Difference: ' }), differenceAmount)),
    reconcileButton,
    h('p', { class: cx(C.muted, 'basis-full text-xs'), text: 'A confirmed difference is saved as a dated adjustment; previous transactions stay unchanged.' }));
  reconciliationForm.onsubmit = async (event) => {
    event.preventDefault();
    const difference = updateReconciliationPreview();
    if (difference === null || Math.abs(difference) < 0.005 || countedAmount.value.trim() === '') return;
    if (!confirm(`Add a ${difference > 0 ? '+' : ''}${money(difference)} reconciliation adjustment for ${dmy(reconcileDate.value)}? This preserves the existing entries.`)) return;
    const counted = Number(countedAmount.value);
    const adjustment: CashEntry = {
      id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      date: reconcileDate.value, kind: 'adjustment', amount: difference, category: 'Uncategorized',
      note: `Reconciliation: counted ${money(counted)}; ledger was ${money(counted - difference)}`,
    };
    try { await saveCashEntry(adjustment); toast('Cash balance reconciled'); }
    catch (e) { toast(`Could not save reconciliation: ${String(e)}`, 'err'); }
  };
  updateReconciliationPreview();
  container.appendChild(reconciliationForm);

  const date = h('input', { class: C.input, attrs: { type: 'date', value: editing?.date ?? new Date().toISOString().slice(0, 10), required: true } }) as HTMLInputElement;
  const kind = h('select', { class: C.input },
    h('option', { text: 'Expense', attrs: { value: 'expense' } }),
    h('option', { text: 'Income', attrs: { value: 'income' } })) as HTMLSelectElement;
  kind.value = editing?.kind ?? 'expense';
  const amount = h('input', { class: cx(C.input, 'w-32'), attrs: { type: 'number', min: '0.01', step: '0.01', placeholder: 'Amount', 'aria-label': 'Amount', value: editing ? String(editing.amount) : '', required: true } }) as HTMLInputElement;
  const category = h('select', { class: C.input },
    h('option', { text: 'Uncategorized', attrs: { value: '' } }),
    ...state.settings.categories.map((c) => h('option', { text: c.tag, attrs: { value: c.tag } }))) as HTMLSelectElement;
  category.value = editing?.category ?? '';
  const note = h('input', { class: cx(C.input, 'min-w-[180px] flex-1'), attrs: { type: 'text', placeholder: 'Note / description', 'aria-label': 'Note or description', value: editing?.note ?? '' } }) as HTMLInputElement;
  const saveBtn = h('button', { class: C.btnPrimary, attrs: { type: 'submit' } }, Ic(editing ? Pencil : Plus, 'size-3.5'), editing ? 'Save entry' : 'Add entry');
  const cancelBtn = editing ? h('button', { class: C.btn, attrs: { type: 'button' }, text: 'Cancel', onclick: () => { editing = null; emit(); } }) : null;
  const form = h('form', { class: cx(C.card, 'mb-3 flex flex-wrap items-end gap-2.5 px-3.5 py-3') },
    h('label', { class: 'flex flex-col gap-1' }, h('span', { class: C.label, text: 'Date' }), date),
    h('label', { class: 'flex flex-col gap-1' }, h('span', { class: C.label, text: 'Type' }), kind),
    h('label', { class: 'flex flex-col gap-1' }, h('span', { class: C.label, text: 'Amount' }), amount),
    h('label', { class: 'flex flex-col gap-1' }, h('span', { class: C.label, text: 'Category' }), category),
    h('label', { class: 'flex min-w-[180px] flex-1 flex-col gap-1' }, h('span', { class: C.label, text: 'Note' }), note), saveBtn, cancelBtn);
  form.onsubmit = async (event) => {
    event.preventDefault();
    const value = Number(amount.value);
    if (!date.value || !Number.isFinite(value) || value <= 0) { toast('Choose a date and enter an amount above zero', 'err'); return; }
    const entry: CashEntry = {
      id: editing?.id ?? (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`),
      date: date.value, kind: kind.value as CashEntry['kind'], amount: value,
      category: category.value, note: note.value.trim(),
    };
    const wasEditing = editing;
    editing = null;
    if (!wasEditing) cashPage = 0;
    try { await saveCashEntry(entry); toast('Cash entry saved'); }
    catch (e) { editing = wasEditing; emit(); toast(`Could not save cash entry: ${String(e)}`, 'err'); }
  };
  container.appendChild(form);

  const sorted = withBalance.slice().reverse();
  const pageCount = Math.max(1, Math.ceil(sorted.length / (cashPageSize || Math.max(1, sorted.length))));
  if (cashPage >= pageCount) cashPage = pageCount - 1;
  const pageRows = cashPageSize === 0 ? sorted : sorted.slice(cashPage * cashPageSize, (cashPage + 1) * cashPageSize);

  // Match the Transactions / Spending table structure: separate sticky header and
  // horizontally scrolling body, with their scroll positions kept in sync.
  const widths = [112, 165, 150, 300, 124, 145, 82];
  const makeTable = (): { table: HTMLTableElement; cols: HTMLTableColElement[] } => {
    const table = h('table', { class: 'border-separate border-spacing-0 text-[13px]', style: { tableLayout: 'fixed' } });
    const colgroup = h('colgroup');
    const cols = widths.map((width) => {
      const col = h('col');
      col.style.width = `${width}px`;
      colgroup.appendChild(col);
      return col;
    });
    table.appendChild(colgroup);
    table.style.width = `${widths.reduce((sum, width) => sum + width, 0)}px`;
    table.style.minWidth = '100%';
    return { table, cols };
  };
  const head = makeTable();
  const body = makeTable();
  const labels = ['Date', 'Movement', 'Category', 'Note', 'Change', 'Balance', ''];
  head.table.appendChild(h('thead', {}, h('tr', {},
    ...labels.map((label) => h('th', { class: cx(C.th, label === 'Change' || label === 'Balance' ? C.num : 'text-left'), text: label })))));
  const tbody = h('tbody');
  for (const [i, row] of pageRows.entries()) {
    const tr = h('tr', { class: cx('hover:bg-muted/40', i % 2 === 1 && 'bg-zebra') });
    tr.appendChild(h('td', { class: cx(C.td, C.mono), text: dmy(row.date) }));
    tr.appendChild(h('td', { class: C.td }, row.label, row.tx ? h('span', { class: cx(C.chipWarn, 'ml-1'), text: 'bank' }) : null));
    tr.appendChild(h('td', { class: C.td }, h('span', { class: 'block truncate', text: row.category, title: row.category })));
    tr.appendChild(h('td', { class: C.td }, h('span', { class: 'block truncate', text: row.note, title: row.note })));
    tr.appendChild(h('td', { class: cx(C.td, C.num, row.delta < 0 ? 'text-danger' : 'text-success'), text: `${row.delta > 0 ? '+' : ''}${num2(row.delta)}` }));
    tr.appendChild(h('td', { class: cx(C.td, C.num, 'font-semibold', row.balance < 0 && 'text-danger'), text: money(row.balance) }));
    const actions = h('td', { class: cx(C.td, 'text-right') });
    if (row.entry) {
      if (row.entry.kind !== 'adjustment') {
        actions.appendChild(h('button', { class: C.link, title: 'Edit entry', onclick: () => { editing = row.entry!; emit(); } }, Ic(Pencil, 'size-3.5')));
      }
      actions.appendChild(h('button', { class: C.linkDanger, title: 'Delete entry', onclick: async () => {
        if (!confirm('Delete this cash entry?')) return;
        try { await removeCashEntry(row.entry!.id); if (editing?.id === row.entry!.id) editing = null; toast('Cash entry deleted'); }
        catch (e) { toast(`Could not delete cash entry: ${String(e)}`, 'err'); }
      } }, Ic(Trash2, 'size-3.5')));
    }
    tr.appendChild(actions);
    tbody.appendChild(tr);
  }
  if (sorted.length === 0) tbody.appendChild(h('tr', {}, h('td', { class: cx(C.td, C.muted, 'py-8 text-center'), attrs: { colspan: '7' }, text: 'No cash movements yet. Add an entry above, or mark withdrawal / deposit categories in Categories.' })));
  body.table.appendChild(tbody);
  const headBox = h('div', { class: cx(C.card, 'sticky top-[var(--appbar-h)] z-20 overflow-x-hidden border-b-0') }, head.table);
  const bodyBox = h('div', { class: cx(C.card, 'overflow-x-auto border-t-0') }, body.table);
  bodyBox.addEventListener('scroll', () => { headBox.scrollLeft = bodyBox.scrollLeft; }, { passive: true });
  attachDragPan(bodyBox);
  attachDragPan(bodyBox, headBox);
  container.appendChild(h('div', {}, headBox, bodyBox));

  const sizeSel = h('select', {
    class: cx(C.input, 'px-2 py-1'), title: 'number of cash movements shown per page',
    onchange: () => {
      cashPageSize = Number(sizeSel.value);
      try { localStorage.setItem(CASH_PAGE_SIZE_KEY, String(cashPageSize)); } catch { /* ignore */ }
      cashPage = 0;
      emit();
    },
  }, ...CASH_PAGE_SIZES.map((size) => h('option', { text: size === 0 ? 'All' : String(size), attrs: { value: String(size) } }))) as HTMLSelectElement;
  sizeSel.value = String(cashPageSize);
  const pageButton = (icon: typeof ChevronsLeft, title: string, target: number, disabled: boolean): HTMLElement =>
    h('button', {
      class: cx('grid size-7 place-items-center border transition-colors select-none',
        disabled ? 'cursor-default border-border opacity-35' : 'cursor-pointer border-border bg-card text-foreground hover:border-input hover:bg-muted/50'),
      attrs: { disabled: disabled ? '' : null }, title,
      onclick: () => { if (!disabled) { cashPage = Math.min(Math.max(0, target), pageCount - 1); emit(); } },
    }, Ic(icon, 'size-3.5'));
  const shownFrom = sorted.length === 0 ? 0 : cashPage * (cashPageSize || sorted.length) + 1;
  const shownTo = Math.min(cashPage * (cashPageSize || sorted.length) + pageRows.length, sorted.length);
  container.appendChild(h('div', { class: 'mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]' },
    h('span', { class: C.muted, text: `${sorted.length} cash movements · showing ${shownFrom}–${shownTo}` }),
    h('div', { class: 'ml-auto flex flex-wrap items-center gap-2' },
      h('span', { class: C.label, text: 'per page' }), sizeSel,
      h('div', { class: 'flex items-center gap-1' },
        pageButton(ChevronsLeft, 'First page', 0, cashPage === 0),
        pageButton(ChevronLeft, 'Previous page', cashPage - 1, cashPage === 0),
        h('span', { class: 'min-w-[96px] text-center text-[12.5px] tabular-nums', text: `Page ${cashPage + 1} / ${pageCount}` }),
        pageButton(ChevronRight, 'Next page', cashPage + 1, cashPage >= pageCount - 1),
        pageButton(ChevronsRight, 'Last page', pageCount - 1, cashPage >= pageCount - 1),
      ),
    ),
  ));
  container.appendChild(h('p', { class: cx(C.muted, 'mt-2 text-xs') },
    Ic(Banknote, 'inline size-3.5'), ' Cash expenses are included in Spending. Marked bank withdrawals and deposits change this balance only; they are not counted as expenses or income. A negative balance is allowed.'));
}
