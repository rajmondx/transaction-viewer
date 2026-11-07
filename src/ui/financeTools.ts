import type { Settings, Tx } from '../types';
import { state, emit, updateFinance } from '../state';
import { matchTx } from '../categories/engine';
import { allTransactionRows, isCashTransfer } from '../cash';
import { annotateRows, validSplit } from '../finance/reporting';
import { minor, type FinanceData, type SplitPart } from '../finance/model';
import { putSettingsObj } from '../storage/settings';
import { C, cx, h, num2 } from './util';

export const financeRows = (): Tx[] => annotateRows(allTransactionRows(state.txs, state.cashEntries), state.finance, state.settings);
export function bundle(data: FinanceData, name: string) {
  if (!Object.prototype.hasOwnProperty.call(data.bundles, name)) {
    Object.defineProperty(data.bundles, name, { value: { annotations: {}, budgets: [] }, enumerable: true, writable: true, configurable: true });
  }
  return data.bundles[name];
}
export function input(value: string, type = 'text'): HTMLInputElement {
  return h('input', { class: cx(C.input, 'max-w-full min-w-0'), attrs: { type, value, ...(type === 'number' ? { min: '0', step: '0.01' } : {}) } });
}
export const labeled = (name: string, control: HTMLElement): HTMLElement => {
  control.setAttribute('aria-label', name);
  return h('label', { class: 'flex min-w-0 flex-col gap-1 text-xs' }, name, control);
};
export function categorySelect(value: string): HTMLSelectElement {
  const tags = [...new Set([...state.settings.categories.map((c) => c.tag), 'Uncategorized', value].filter(Boolean))];
  return h('select', { class: cx(C.input, 'max-w-full'), attrs: { 'aria-label': 'Category' } }, ...tags.map((tag) => h('option', { attrs: { value: tag, selected: tag === value } }, tag)));
}

/** Native dialog supplies modal focus trapping and Escape; close restores focus. */
export function financeDialog(title: string, build: (body: HTMLElement, close: () => void, run: (action: () => Promise<void>) => Promise<void>) => void): void {
  const focus = document.activeElement as HTMLElement | null;
  const focusKey = focus?.dataset.fk;
  const focusLabel = focus?.getAttribute('aria-label');
  const focusText = focus?.textContent;
  const error = h('p', { class: 'text-sm text-danger', attrs: { role: 'alert' } });
  const body = h('div', { class: 'flex flex-col gap-4' });
  const dialog = h('dialog', { class: 'm-auto max-h-[90vh] w-[min(700px,94vw)] overflow-y-auto border border-border bg-card p-4 text-foreground shadow-card backdrop:bg-black/50', attrs: { 'aria-labelledby': 'finance-dialog-title' } });
  const close = () => dialog.close();
  let busy = false;
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    busy = true; error.textContent = '';
    dialog.setAttribute('aria-busy', 'true');
    try { await action(); } catch (e) { error.textContent = (e as Error).message; }
    finally { busy = false; dialog.removeAttribute('aria-busy'); }
  };
  dialog.append(h('div', { class: 'mb-4 flex items-center justify-between gap-2' },
    h('h2', { class: 'font-semibold', attrs: { id: 'finance-dialog-title' } }, title), h('button', { class: C.btn, onclick: () => { if (!busy) close(); } }, 'Close')), body, error);
  build(body, close, run);
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (focus?.isConnected) focus.focus();
    else if (focusKey) document.querySelector<HTMLElement>(`[data-fk="${CSS.escape(focusKey)}"]`)?.focus();
    else if (focusText || focusLabel) Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
      focusLabel ? button.getAttribute('aria-label') === focusLabel : button.textContent === focusText)?.focus();
  });
  dialog.addEventListener('cancel', (e) => { if (busy) e.preventDefault(); });
  document.body.append(dialog); dialog.showModal();
}

export function transactionTools(tx: Tx): HTMLElement {
  return h('button', { class: cx(C.link, 'shrink-0'), dataset: { fk: `transaction-tools-${tx.parentId ?? tx.id}` }, title: 'Correct category or split this transaction', attrs: { 'aria-label': `Edit transaction: ${tx.text}` },
    onclick: (e) => { e.stopPropagation(); openTransactionTools(tx); } }, 'Edit');
}

export function openTransactionTools(row: Tx): void {
  const id = row.parentId ?? row.id;
  const tx = financeRows().find((t) => t.id === id);
  if (!tx) return;
  const name = state.activeSettingsName;
  financeDialog('Transaction category & splits', (body, close, run) => {
    body.append(h('p', { class: 'text-sm break-words' }, `${tx.bookingDate} · ${tx.text} · ${num2(tx.credit - tx.debit)}`),
      h('p', { class: C.muted }, `Changes apply to category bundle “${name}”. Original amount and bank balances never change.`));
    const cat = categorySelect(matchTx(tx, state.settings));
    const annotation = state.finance.bundles[name]?.annotations[id];
    const actions = h('div', { class: 'flex flex-wrap gap-2' },
      h('button', { class: C.btnPrimary, onclick: () => void run(async () => {
        if (annotation?.parts) throw new Error('Remove the split before setting a category for the whole transaction.');
        await updateFinance((data) => { const b = bundle(data, name); b.annotations[id] = { ...b.annotations[id], category: cat.value }; }); close();
      }) }, 'Only this transaction'),
      h('button', { class: C.btn, onclick: () => { close(); openRuleCreator(tx, cat.value); } }, 'Create a rule for similar ones'),
      h('button', { class: C.btn, onclick: () => void run(async () => {
        await updateFinance((data) => { const a = bundle(data, name).annotations[id]; if (a) delete a.category; }); close();
      }) }, 'Reset to rules'));
    if (tx.cashAdjustment) { body.append(h('p', {}, 'Reconciliation corrections are managed in Cash balance & entries.')); return; }
    body.append(labeled('Category', cat), actions);
    if (tx.internalTransfer || isCashTransfer(tx, state.settings)) {
      body.append(h('p', { class: C.muted }, 'Transfers cannot be split. Unlink an internal transfer first.')); return;
    }
    if ((tx.credit > 0) === (tx.debit > 0)) return;
    const parts: SplitPart[] = structuredClone(annotation?.parts ?? [
      { amount: 0, category: cat.value, note: '' }, { amount: 0, category: cat.value, note: '' },
    ]);
    const editor = h('div', { class: 'flex flex-col gap-2' });
    const remainder = h('p', { class: 'text-sm', attrs: { 'aria-live': 'polite' } });
    const updateRemainder = () => { remainder.textContent = `Unallocated: ${num2((minor(tx.credit + tx.debit) - parts.reduce((s, p) => s + minor(p.amount), 0)) / 100)}`; };
    const draw = () => {
      editor.replaceChildren(...parts.map((part, i) => {
        const amount = input(part.amount ? part.amount.toFixed(2) : '', 'number');
        const category = categorySelect(part.category), note = input(part.note);
        amount.oninput = () => { part.amount = amount.value === '' ? 0 : Number(amount.value); updateRemainder(); };
        category.onchange = () => { part.category = category.value; };
        note.oninput = () => { part.note = note.value; };
        return h('div', { class: 'flex flex-wrap items-end gap-2 bg-muted/40 p-3' }, labeled(`Part ${i + 1} amount`, amount), labeled('Category', category), labeled('Note', note),
          h('button', { class: C.btnSm, onclick: () => { part.amount = Math.max(0, (minor(tx.credit + tx.debit) - parts.reduce((s, p, j) => s + (i === j ? 0 : minor(p.amount)), 0)) / 100); draw(); } }, 'Use remainder'),
          h('button', { class: C.btnSm, onclick: () => { if (parts.length > 2) { parts.splice(i, 1); draw(); } } }, 'Remove part'));
      })); updateRemainder();
    };
    draw();
    body.append(h('h3', { class: 'border-t border-border pt-3 font-semibold' }, 'Split transaction'),
      h('p', { class: C.muted }, 'At least two positive parts must equal the original amount exactly. Rules do not overwrite split categories.'), editor, remainder,
      h('div', { class: 'flex flex-wrap gap-2' },
        h('button', { class: C.btn, onclick: () => { parts.push({ amount: 0, category: cat.value, note: '' }); draw(); } }, 'Add part'),
        h('button', { class: C.btnPrimary, onclick: () => void run(async () => {
          if (!validSplit(tx, parts)) throw new Error('Enter at least two positive amounts whose sum equals the original total.');
          await updateFinance((data) => { const b = bundle(data, name); b.annotations[id] = { ...b.annotations[id], parts }; }); close();
        }) }, 'Save split'),
        h('button', { class: C.btn, onclick: () => void run(async () => { await updateFinance((data) => { const a = bundle(data, name).annotations[id]; if (a) delete a.parts; }); close(); }) }, 'Remove split')));
  });
}

function openRuleCreator(tx: Tx, initial: string): void {
  financeDialog('Create a rule for similar transactions', (body, close, run) => {
    const cat = categorySelect(initial), text = input(tx.text);
    const mode = h('select', { class: C.input }, ...['contains', 'case-sensitive', 'regex'].map((m) => h('option', { attrs: { value: m } }, m)));
    const iban = input('');
    const replace = h('input', { attrs: { type: 'checkbox' } });
    const first = h('input', { attrs: { type: 'checkbox' } });
    const preview = h('div', { class: 'max-h-64 overflow-y-auto bg-muted/40 p-3 text-xs', attrs: { 'aria-live': 'polite' } });
    const proposed = (): Settings => {
      const settings = structuredClone(state.settings), target = settings.categories.find((c) => c.tag === cat.value);
      if (!target) throw new Error('Choose an existing category. Add new categories on the Categories page.');
      if (!text.value.trim()) throw new Error('Enter a non-empty matching description.');
      if (mode.value === 'regex') new RegExp(text.value);
      const constraint = iban.value.replace(/\s/g, '').toUpperCase();
      const constrained = target.ibans.length || target.dateFrom || target.dateTo || constraint;
      if (!replace.checked && constrained) throw new Error('This category or new rule has constraints. Explicitly allow replacement below, or edit the category manually.');
      const rule = { text: text.value, regex: mode.value === 'regex', caseSensitive: mode.value === 'case-sensitive', fuzzy: false };
      if (replace.checked) { target.rules = [rule]; target.ibans = constraint ? [constraint] : []; target.dateFrom = null; target.dateTo = null; }
      else target.rules.push(rule);
      target.enabled = true;
      if (first.checked) settings.categories = [target, ...settings.categories.filter((c) => c !== target)];
      return settings;
    };
    const draw = () => {
      try {
        const next = proposed(), changes = financeRows().filter((t) => matchTx(t, state.settings) !== matchTx(t, next));
        preview.replaceChildren(h('div', {}, h('strong', {}, `${changes.length} existing transactions change category. Manual overrides remain in place.`),
          ...changes.slice(0, 100).map((t) => h('p', { class: 'mt-1 break-words' }, `${t.bookingDate} · ${t.text} · ${matchTx(t, state.settings)} → ${matchTx(t, next)}`)),
          changes.length > 100 ? h('p', {}, 'Showing first 100 changes.') : null));
      } catch (e) { preview.textContent = (e as Error).message; }
    };
    for (const control of [cat, text, mode, iban, replace, first]) { control.addEventListener('input', draw); control.addEventListener('change', draw); }
    body.append(labeled('Target category', cat), labeled('Description match', text), labeled('Match mode', mode),
      labeled('Optional IBAN constraint (matches the CSV IBAN field, not necessarily a merchant)', iban),
      h('label', { class: 'flex gap-2 text-sm' }, replace, 'Replace this category’s existing rules/IBAN/date constraints with this rule'),
      h('label', { class: 'flex gap-2 text-sm' }, first, 'Move target category to first priority (otherwise earlier matches still win)'),
      h('p', { class: C.muted }, 'Preview shows effective category changes, including effects of priority. Future matching imports use the saved rule. No transaction-only overrides are reset.'), preview,
      h('button', { class: C.btnPrimary, onclick: () => void run(async () => { const next = proposed(); putSettingsObj(next); state.settings = next; emit(); close(); }) }, 'Save rule'));
    draw();
  });
}
