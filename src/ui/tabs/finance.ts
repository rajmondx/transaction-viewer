import { state, emit, selectSettings, updateFinance } from '../../state';
import { C, cx, dmy, h, num2, toast } from '../util';
import { bundle, categorySelect, financeDialog, financeRows, input, labeled, transactionTools } from '../financeTools';
import { detectRecurring, CADENCES, merchantName, recurringKey, type RecurringSeries } from '../../finance/recurring';
import { transferCandidates, pairId } from '../../finance/transfers';
import { validTransfer, validSplit } from '../../finance/reporting';
import { budgetActuals } from '../../finance/budgets';
import { minor, type Cadence, type SeriesDecision } from '../../finance/model';
import { isCashTransfer } from '../../cash';
import { bankAccountKey } from '../../bankBalances';
import type { Tx } from '../../types';
import { DEMO_FILE_NAME } from '../../seed/demoCsv';
import { addDemoFinance } from '../../seed/demoFinance';

let section: 'recurring' | 'transfers' | 'budgets' | 'review' = 'recurring';
let month = new Date().toISOString().slice(0, 7);
let transferWindow = 4;
let recurringFilter = 'all';
let recurringSearch = '';
const run = (action: () => Promise<void>) => { void action().catch((error) => toast((error as Error).message, 'err')); };
const card = (...children: HTMLElement[]): HTMLElement => h('section', { class: 'planning-card' }, children);
const line = (text: string): HTMLElement => h('p', { class: 'planning-note' }, text);
const button = (text: string, action: () => void): HTMLButtonElement => h('button', { class: C.btn, onclick: action }, text);
const primary = (text: string, action: () => void): HTMLButtonElement => h('button', { class: C.btnPrimary, onclick: action }, text);
const badge = (text: string, tone = ''): HTMLElement => h('span', { class: cx('planning-badge', tone && `planning-badge-${tone}`) }, text);
const accountLabel = (tx: Tx): string => tx.accountAlias || (tx.cashEntryId ? 'Cash' : bankAccountKey(tx));
const payment = (tx: Tx): HTMLElement => h('div', { class: 'planning-payment' },
  h('span', { class: 'planning-note' }, dmy(tx.bookingDate)),
  h('div', { class: 'min-w-0' }, h('p', { class: 'planning-payment-name' }, tx.text), h('span', { class: 'planning-note' }, accountLabel(tx))),
  h('strong', { class: 'planning-number' }, num2(tx.credit - tx.debit)), transactionTools(tx));

function explanation(title: string, ...children: HTMLElement[]): HTMLElement {
  return h('details', { class: 'planning-help' }, h('summary', {}, title), h('div', { class: 'planning-help-content' }, children));
}

function metric(label: string, value: string, hint: string, tone = ''): HTMLElement {
  return h('div', { class: 'planning-metric' }, h('span', { class: 'planning-eyebrow' }, label),
    h('strong', { class: cx('planning-metric-value', tone) }, value), h('span', { class: 'planning-note' }, hint));
}

function heading(title: string, description: string, ...actions: HTMLElement[]): HTMLElement {
  return h('div', { class: 'planning-section-heading' },
    h('div', {}, h('h2', {}, title), line(description)), h('div', { class: 'planning-actions' }, actions));
}

function emptyState(title: string, description: string, action?: HTMLElement): HTMLElement {
  return h('div', { class: 'planning-empty' }, h('h3', {}, title), line(description), action);
}

export function renderFinance(container: HTMLElement): void {
  const page = h('div', { class: 'planning' });
  container.append(page);
  const settings = h('select', { class: C.input, attrs: { 'aria-label': 'Category settings bundle' } },
    ...state.settingsFiles.map((s) => h('option', { attrs: { value: s.name, selected: s.name === state.activeSettingsName } }, s.name)));
  settings.onchange = () => run(() => selectSettings(settings.value));
  const rows = financeRows();
  page.append(h('header', { class: 'planning-header' },
    h('div', {}, h('h1', {}, 'Planning'), line('Keep track of regular bills, transfers and spending limits.')),
    labeled('Categories & budgets use', settings)),
  h('nav', { class: 'planning-nav', attrs: { 'aria-label': 'Planning sections' } },
    ...([['recurring', 'Recurring payments', 'Bills & subscriptions'], ['transfers', 'Internal transfers', 'Money between accounts'],
      ['budgets', 'Budgets', 'Monthly spending limits'], ['review', 'Saved edits', 'Corrections & splits']] as const).map(([key, title, subtitle]) =>
      h('button', { class: 'planning-nav-item', dataset: { fk: `planning-nav-${key}` }, attrs: { 'aria-current': section === key ? 'page' : null },
        onclick: () => { section = key; emit(); } }, h('strong', {}, title), h('span', {}, subtitle)))));
  if (section === 'recurring') recurringView(page, rows);
  if (section === 'transfers') transfersView(page, rows);
  if (section === 'budgets') budgetsView(page, rows);
  if (section === 'review') reviewView(page, rows);
  if (rows.some((r) => r.file === DEMO_FILE_NAME)) page.append(explanation('Try these features with demo data',
    line('Adds a sample correction, split, confirmed transfer, subscription and budget. Only demo rows are edited; existing decisions are kept.'),
    button('Add demo planning examples', () => run(() => updateFinance((data) => addDemoFinance(data, rows, state.settings))))));
}

function recurringView(container: HTMLElement, rows: Tx[]): void {
  const series = detectRecurring(rows.filter((r) => !isCashTransfer(r, state.settings)), state.finance.series);
  const confirmed = series.filter((s) => s.status === 'confirmed' && s.outgoing);
  const monthly = confirmed.reduce((sum, s) => sum + s.monthly, 0);
  const suggestions = series.filter((s) => s.status === 'candidate' && s.outgoing);
  container.append(h('div', { class: 'planning-metrics' },
    metric('Monthly commitments', num2(monthly), `${confirmed.length} active outgoing ${confirmed.length === 1 ? 'bill' : 'bills'} · CHF estimate`),
    metric('Yearly estimate', num2(monthly * 12), 'Active outgoing bills only · CHF'),
    metric('Suggestions to review', String(suggestions.length), 'Not included until you confirm', suggestions.length ? 'text-warning' : '')),
  heading('Recurring payments', 'Your regular bills in one place. Confirm a suggestion to start tracking it.',
    primary('Add recurring payment', () => editSeries())));

  const search = input(recurringSearch, 'search');
  search.placeholder = 'Search bills or subscriptions'; search.dataset.fk = 'planning-search'; search.setAttribute('aria-label', 'Search recurring payments');
  search.oninput = () => { recurringSearch = search.value; emit(); };
  const filter = h('select', { class: C.input, dataset: { fk: 'planning-recurring-filter' }, attrs: { 'aria-label': 'Recurring payment status' } },
    ...[['all', 'Active & suggested'], ['confirmed', 'Active bills'], ['candidate', 'Suggestions'], ['income', 'Recurring income'], ['archived', 'Dismissed & ended']].map(([value, title]) =>
      h('option', { attrs: { value, selected: recurringFilter === value } }, title)));
  filter.onchange = () => { recurringFilter = filter.value; emit(); };
  container.append(h('div', { class: 'planning-toolbar' }, search, filter,
    button('Merge groups…', () => mergeSeries(series))));

  const groups = [
    { key: 'confirmed', title: 'Active bills', description: 'Confirmed by you. Included in the commitment estimates above.', items: confirmed },
    { key: 'candidate', title: 'Suggestions', description: 'Possible recurring bills. Check the payment history before confirming.', items: suggestions },
    { key: 'income', title: 'Recurring income', description: 'Kept separate from your outgoing commitments.', items: series.filter((s) => !s.outgoing && !['dismissed', 'ended'].includes(s.status)) },
    { key: 'archived', title: 'Dismissed & ended', description: 'Not included in your commitment estimates.', items: series.filter((s) => ['dismissed', 'ended'].includes(s.status)) },
  ];
  let shown = 0;
  for (const group of groups) {
    if (recurringFilter === 'all' ? group.key === 'archived' : recurringFilter !== group.key) continue;
    const items = group.items.filter((s) => `${s.name} ${s.rows.map((r) => r.text).join(' ')}`.toLowerCase().includes(recurringSearch.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!items.length) continue;
    shown += items.length;
    const list = h('div', { class: 'planning-list' }, ...items.map(recurringCard));
    const title = h('div', { class: 'planning-group-heading' }, h('h3', {}, group.title), badge(String(items.length)));
    if (group.key === 'income' && recurringFilter === 'all') {
      container.append(h('details', { class: 'planning-income' }, h('summary', {}, title), line(group.description), list));
    } else container.append(h('section', { class: 'planning-group' }, title, line(group.description), list));
  }
  if (!shown) container.append(emptyState('No payments in this view', recurringSearch ? 'Try a different search or status filter.' : 'Import more statement history, or add a recurring payment yourself.'));
  container.append(explanation('How estimates and suggestions work',
    line('Only active, confirmed outgoing payments count towards commitments. Suggestions, income, dismissed and ended payments are excluded.'),
    line('Detection runs on your device. Expected dates are approximate, based on imported history—not live bank monitoring. A missing payment does not prove a bill is overdue.'),
    line('Monthly estimates use 52/12 for weekly bills, 26/12 for fortnightly, 1/3 for quarterly and 1/12 for annual. Variable bills use the median observed amount.'),
    line('Price-change alerts compare the latest payment against earlier stable payments, with a tolerance of the greater of CHF 1.00 or 3%. Variable bills show ranges instead.')));
  const missing = state.finance.series.filter((s) => !series.some((v) => v.id === s.id));
  if (missing.length) container.append(explanation(`${missing.length} saved payments need imported history`, line('Their saved decisions are retained, but no eligible transactions are currently available.'),
    ...missing.map((s) => h('div', { class: 'flex flex-wrap gap-2' }, line(`${s.name} · ${s.status}`), button('Remove saved decision', () => run(() => updateFinance((data) => { data.series = data.series.filter((d) => d.id !== s.id); })))))));
}

function setSeriesStatus(s: RecurringSeries, status: SeriesDecision['status']): void {
  run(() => updateFinance((data) => { data.series = [...data.series.filter((d) => d.id !== s.id), decisionOf(s, status)]; }));
}

function recurringCard(s: RecurringSeries): HTMLElement {
  const suggested = s.status === 'candidate';
  const status = suggested ? 'Suggested' : s.status === 'confirmed' ? 'Active' : s.status === 'ended' ? 'Ended' : 'Dismissed';
  const details = h('details', { class: 'planning-item-details' }, h('summary', {}, `Payment history & options (${s.rows.length})`),
    h('div', { class: 'planning-details-body' },
      h('div', { class: 'planning-facts' },
        h('div', {}, h('span', { class: 'planning-eyebrow' }, 'Last payment'), h('strong', {}, dmy(s.rows.at(-1)!.bookingDate))),
        h('div', {}, h('span', { class: 'planning-eyebrow' }, 'Observed range'), h('strong', {}, `${num2(s.min)} – ${num2(s.max)}`)),
        h('div', {}, h('span', { class: 'planning-eyebrow' }, 'Pattern confidence'), h('strong', {}, s.confidence))),
      line(s.reason), h('div', { class: 'planning-history' }, ...s.rows.map(payment)),
      h('div', { class: 'planning-actions' }, button('Edit payment…', () => editSeries(s)),
        ...(s.status === 'confirmed' ? [button('Mark ended', () => setSeriesStatus(s, 'ended'))] : []),
        ...(s.status === 'dismissed' || s.status === 'ended' ? [button('Reactivate', () => setSeriesStatus(s, 'confirmed'))] : []),
        ...(s.status !== 'dismissed' ? [button('Dismiss', () => setSeriesStatus(s, 'dismissed'))] : []),
        ...(!suggested ? [button('Reset decision', () => run(() => updateFinance((data) => { data.series = data.series.filter((d) => d.id !== s.id); })))] : []))));
  return h('article', { class: 'planning-item' },
    h('div', { class: 'planning-recurring-row' },
      h('div', { class: 'planning-item-title' }, h('div', { class: 'planning-actions' }, h('h4', { title: s.name }, recurringTitle(s)), badge(status, suggested ? 'warning' : s.status === 'confirmed' ? 'success' : '')),
        line(`${s.cadence.charAt(0).toUpperCase() + s.cadence.slice(1)} · ${s.variable ? 'Variable amount' : 'Fixed amount'}`)),
      h('div', { class: 'planning-amount' }, h('strong', {}, num2(s.monthly)), h('span', {}, 'CHF / month · estimated')),
      h('div', { class: 'planning-next' }, h('span', { class: 'planning-eyebrow' }, s.status === 'ended' || s.status === 'dismissed' ? 'Last observed' : 'Next expected'),
        h('strong', {}, dmy(s.status === 'ended' || s.status === 'dismissed' ? s.rows.at(-1)!.bookingDate : s.next))),
      suggested ? h('div', { class: 'planning-actions' }, primary('Confirm', () => setSeriesStatus(s, 'confirmed')),
        button('Not recurring', () => setSeriesStatus(s, 'dismissed'))) : null),
    s.change !== null && !['dismissed', 'ended'].includes(s.status) ? h('div', { class: 'planning-price-change' },
      badge(s.change > 0 ? 'Price increased' : 'Price decreased', s.change > 0 ? 'warning' : 'success'),
      h('span', {}, `${s.change > 0 ? '+' : ''}${num2(s.change)} CHF per payment vs previous stable payments`)) : null,
    details);
}

/** Prefer original merchant casing to the detector's normalized matching key.
 * User-written series names remain untouched; full descriptions stay in history. */
function recurringTitle(s: RecurringSeries): string {
  if (s.name !== merchantName(s.rows[0].text)) return s.name;
  const parts = s.rows[0].text.split(/\s*⏐\s*|\n/);
  if (parts.length > 1 && parts[1].trim()) return parts[1].trim();
  return parts[0].replace(/^direct debit\s+/i, '')
    .replace(/^debit card\s+\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}\s+/i, '')
    .replace(/\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}$/i, '').trim();
}

function decisionOf(s: RecurringSeries, status: SeriesDecision['status']): SeriesDecision {
  return { id: s.id, name: s.name, cadence: s.cadence, variable: s.variable, status, keys: s.keys, txIds: s.rows.map((r) => r.id) };
}

function editSeries(series?: RecurringSeries): void {
  financeDialog(series ? 'Edit recurring payment' : 'Add recurring payment', (body, close, guarded) => {
    body.classList.add('planning-editor');
    const name = input(series ? recurringTitle(series) : ''), cadence = h('select', { class: C.input }, ...CADENCES.map((c) => h('option', { attrs: { value: c, selected: c === (series?.cadence ?? 'monthly') } }, c.charAt(0).toUpperCase() + c.slice(1))));
    const variable = h('input', { attrs: { type: 'checkbox', checked: series?.variable ?? false } });
    const future = h('input', { attrs: { type: 'checkbox', checked: (series?.keys.length ?? 0) > 0 } });
    const search = input('', 'search'), list = h('div', { class: 'planning-picker-list' });
    search.placeholder = 'Find a payment in your statements';
    const showAll = h('input', { attrs: { type: 'checkbox', checked: !series, 'aria-label': 'Show other available payments' } });
    const selected = new Set(series?.rows.map((r) => r.id) ?? []);
    const eligible = financeRows().filter((r) => !r.internalTransfer && !r.cashAdjustment && !isCashTransfer(r, state.settings) && (r.debit > 0) !== (r.credit > 0));
    const count = h('p', { class: 'text-sm', attrs: { 'aria-live': 'polite' } });
    const draw = () => {
      const found = eligible.filter((r) => selected.has(r.id) || (showAll.checked && (!search.value || r.text.toLowerCase().includes(search.value.toLowerCase()))))
        .sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)) || b.bookingDate.localeCompare(a.bookingDate));
      list.replaceChildren(...found.slice(0, 200).map((r) => {
        const check = h('input', { attrs: { type: 'checkbox', checked: selected.has(r.id) } });
        check.onchange = () => { if (check.checked) selected.add(r.id); else selected.delete(r.id); count.textContent = `${selected.size} payments selected`; };
        return h('label', { class: 'planning-picker-row' }, check,
          h('div', {}, h('span', { class: 'planning-picker-description' }, r.text), line(`${dmy(r.bookingDate)} · ${accountLabel(r)}`)),
          h('strong', { class: 'planning-number' }, num2(r.credit - r.debit)));
      })); count.textContent = `${selected.size} payments selected · showing ${Math.min(found.length, 200)} of ${found.length}; search to narrow`;
    };
    search.oninput = () => { if (search.value) showAll.checked = true; draw(); };
    showAll.onchange = draw; draw();
    const save = async (split: boolean) => {
      const members = eligible.filter((r) => selected.has(r.id));
      if (!name.value.trim() || !members.length) throw new Error('Enter a name and choose at least one payment.');
      if (members.some((r) => (r.debit > 0) !== (members[0].debit > 0))) throw new Error('Keep incoming and outgoing series separate.');
      const keys = future.checked ? [...new Set(members.map(recurringKey))] : [];
      await updateFinance((data) => {
        const other = data.series.filter((d) => d.id !== series?.id);
        if (other.some((d) => d.txIds.some((id) => selected.has(id)) || d.keys.some((k) => keys.includes(k)))) {
          throw new Error('These payments or future matching keys belong to another saved series. Merge or edit that series first.');
        }
        const next: SeriesDecision = { id: split || !series ? crypto.randomUUID() : series.id, name: name.value.trim(), cadence: cadence.value as Cadence,
          variable: variable.checked, status: 'confirmed', txIds: members.map((r) => r.id), keys: split ? [] : keys };
        if (split && series) {
          const remaining = series.rows.filter((r) => !selected.has(r.id));
          if (!remaining.length) throw new Error('Leave at least one payment in the original series to split it.');
          const old = decisionOf(series, 'confirmed'); old.keys = []; old.txIds = remaining.map((r) => r.id);
          data.series = [...other, old, next];
        } else data.series = [...other, next];
      }); close();
    };
    body.append(h('div', { class: 'planning-editor-fields' }, labeled('Payment name', name), labeled('Repeats', cadence)),
      h('label', { class: 'flex items-start gap-2 text-sm' }, variable, 'Amount varies (for example, an electricity bill)'),
      h('label', { class: 'flex items-start gap-2 text-sm' }, future, 'Automatically include matching future payments'),
      labeled('Find payments', search),
      h('label', { class: 'flex items-center gap-2 text-xs' }, showAll, 'Show other available payments'), count, list,
      explanation('Matching rules & advanced options',
        line('Automatic matching uses the account, payment direction and normalized description of your selections. To permanently exclude an individual payment, turn automatic matching off before deselecting it.'),
        ...(series ? [line('If these payments belong to different bills, select the ones to move into a new group. Splitting turns automatic matching off for both groups so they do not join again.'),
          button('Move selected to a new group', () => void guarded(() => save(true)))] : [])),
      primary('Save & confirm payment', () => void guarded(() => save(false))));
  });
}

function mergeSeries(series: RecurringSeries[]): void {
  const eligible = series.filter((s) => s.status !== 'candidate');
  financeDialog('Merge recurring payment groups', (body, close, guarded) => {
    const selected = new Set<string>();
    for (const s of eligible) {
      const check = h('input', { attrs: { type: 'checkbox' } });
      check.onchange = () => { if (check.checked) selected.add(s.id); else selected.delete(s.id); };
      body.append(h('label', { class: 'flex gap-2 text-sm' }, check, `${s.name} · ${s.cadence} · ${s.status}`));
    }
    body.append(line('Choose at least two. The first selected series in this list supplies name, cadence and fixed/variable behavior; review the merged result afterwards.'),
      button('Merge', () => void guarded(async () => {
        const chosen = eligible.filter((s) => selected.has(s.id));
        if (chosen.length < 2 || chosen.some((s) => s.outgoing !== chosen[0].outgoing)) throw new Error('Choose at least two series with the same payment direction.');
        const next = decisionOf(chosen[0], 'confirmed'); next.txIds = [...new Set(chosen.flatMap((s) => s.rows.map((r) => r.id)))]; next.keys = [...new Set(chosen.flatMap((s) => s.keys))];
        await updateFinance((data) => { data.series = [...data.series.filter((s) => !selected.has(s.id)), next]; }); close();
      })));
  });
}

function transfersView(container: HTMLElement, rows: Tx[]): void {
  const window = input(String(transferWindow), 'number'); window.step = '1'; window.min = '0'; window.max = '30';
  window.onchange = () => { transferWindow = Math.min(30, Math.max(0, Number(window.value) || 0)); emit(); };
  const suggestions = transferCandidates(rows, state.finance, state.settings, transferWindow);
  const links = state.finance.transfers.map((link) => ({ link, a: rows.find((r) => r.id === link.left), b: rows.find((r) => r.id === link.right) }));
  const active = links.filter(({ a, b }) => a?.internalTransfer && b?.internalTransfer);
  const broken = links.filter((v) => !active.includes(v));
  container.append(h('div', { class: 'planning-metrics' }, metric('Pairs to review', String(suggestions.length), 'Nothing is excluded automatically'),
    metric('Confirmed transfers', String(active.length), 'Excluded from spending & budgets'),
    metric('Need attention', String(broken.length), 'Missing or incompatible payments', broken.length ? 'text-warning' : '')),
  heading('Internal transfers', 'Match money moving between your own accounts so it is not counted as spending.',
    button('Pair manually…', manualTransfer)),
  explanation('Matching options & important checks', labeled('Suggestion date window (days)', window),
    line('Confirm only transfers between your own accounts. Verify the currency: the CSV model does not track currencies separately. Only equal, opposite amounts can be paired.'),
    line('Cash transfers, split payments and unknown accounts cannot be paired. Confirmed transfers remain in the transaction ledger and never change account balances.'),
    ...(state.finance.rejectedTransfers.length ? [button(`Reset ${state.finance.rejectedTransfers.length} rejected pairs`, () => run(() => updateFinance((data) => { data.rejectedTransfers = []; })))] : [])));
  if (broken.length) container.append(h('section', { class: 'planning-group' }, h('div', { class: 'planning-group-heading' }, h('h3', {}, 'Needs attention'), badge(String(broken.length), 'warning')),
    ...broken.map(({ link, a, b }) => card(badge('Exclusion inactive', 'warning'), line('One payment is missing or incompatible. These movements are counted until the pair is valid again.'),
      ...(a ? [payment(a)] : [line(`Missing payment: ${link.left}`)]), ...(b ? [payment(b)] : [line(`Missing payment: ${link.right}`)]),
      button('Unlink pair', () => run(() => updateFinance((data) => { data.transfers = data.transfers.filter((t) => t.id !== link.id); })))))));
  container.append(h('div', { class: 'planning-group-heading' }, h('h3', {}, 'Suggested matches'), badge(String(suggestions.length))),
    line('Check both accounts before confirming a pair. Suggestions are still included in your reports.'));
  if (!suggestions.length) container.append(emptyState('No transfers to review', 'All available matches have been reviewed, or no matching opposite payments were found.'));
  for (const suggestion of suggestions.slice(0, 100)) {
    container.append(h('article', { class: 'planning-transfer planning-card' },
      h('div', { class: 'planning-transfer-route' }, transferAccount('From', suggestion.left), h('span', { class: 'planning-transfer-arrow', attrs: { 'aria-hidden': 'true' } }, '→'), transferAccount('To', suggestion.right),
        h('div', { class: 'planning-amount' }, h('strong', {}, num2(suggestion.left.debit)), h('span', {}, 'CHF · matching amounts'))),
      h('div', { class: 'planning-transfer-footer' }, line(`${suggestion.days === 0 ? 'Same booking date' : `${suggestion.days} days apart`} · ${dmy(suggestion.left.bookingDate)}`),
        h('div', { class: 'planning-actions' }, primary('Confirm transfer', () => run(() => confirmTransfer(suggestion.left, suggestion.right))),
          button('Not a transfer', () => run(() => updateFinance((data) => { data.rejectedTransfers.push(suggestion.id); }))))),
      explanation('Compare original payments', line(suggestion.reason), payment(suggestion.left), payment(suggestion.right))));
  }
  if (suggestions.length > 100) container.append(line('Showing first 100 suggestions. Narrow the date window to reduce matches.'));
  if (active.length) container.append(explanation(`Confirmed transfers (${active.length})`,
    line('These pairs are excluded from Spending and budgets. Unlink a pair to count its payments again.'),
    ...active.map(({ link, a, b }) => h('div', { class: 'planning-confirmed-transfer' },
      h('div', {}, h('strong', {}, `${accountLabel(a!)} → ${accountLabel(b!)}`), line(`${dmy(a!.bookingDate)} · CHF ${num2(a!.debit || a!.credit)}`)),
      button('Unlink', () => run(() => updateFinance((data) => { data.transfers = data.transfers.filter((t) => t.id !== link.id); })))))));
}

function transferAccount(label: string, tx: Tx): HTMLElement {
  return h('div', { class: 'planning-transfer-account' }, h('span', { class: 'planning-eyebrow' }, label), h('strong', {}, accountLabel(tx)), line(dmy(tx.bookingDate)));
}

async function confirmTransfer(a: Tx, b: Tx): Promise<void> {
  await updateFinance((data) => {
    if (!validTransfer(a, b) || isCashTransfer(a, state.settings) || isCashTransfer(b, state.settings)) throw new Error('Choose equal opposite movements on distinct identified accounts, not cash transfers.');
    if (Object.values(data.bundles).some((v) => v.annotations[a.id]?.parts || v.annotations[b.id]?.parts)) throw new Error('Remove existing splits first (including splits in other bundles).');
    if (data.transfers.some((t) => [t.left, t.right].some((id) => id === a.id || id === b.id))) throw new Error('A payment is already linked. Unlink it first.');
    data.transfers.push({ id: pairId(a.id, b.id), left: a.id, right: b.id });
  });
}

function manualTransfer(): void {
  financeDialog('Pair an internal transfer', (body, close, guarded) => {
    const rows = financeRows().filter((r) => !r.cashEntryId && !r.internalTransfer);
    const select = () => h('select', { class: cx(C.input, 'w-full'), attrs: { 'aria-label': 'Transfer leg' } },
      h('option', { attrs: { value: '' } }, 'Choose a payment'), ...rows.map((r) => h('option', { attrs: { value: r.id } }, `${r.bookingDate} · ${r.accountAlias || bankAccountKey(r)} · ${num2(r.credit - r.debit)} · ${r.text}`)));
    const left = select(), right = select();
    body.append(labeled('First leg', left), labeled('Opposite leg', right), line('Manual pairing permits dates outside the suggestion window. Verify both account ownership and currency before confirming.'),
      button('Confirm pair', () => void guarded(async () => { const a = rows.find((r) => r.id === left.value), b = rows.find((r) => r.id === right.value); if (!a || !b) throw new Error('Choose both payments.'); await confirmTransfer(a, b); close(); })));
  });
}

function budgetsView(container: HTMLElement, rows: Tx[]): void {
  const bundleName = state.activeSettingsName;
  const date = input(month, 'month'); date.onchange = () => { if (/^\d{4}-\d{2}$/.test(date.value)) { month = date.value; emit(); } };
  container.append(heading('Monthly budgets', 'See what you have spent and what is left in each category.', labeled('Budget month', date), primary('Add budget', () => editBudget())),
    explanation('What counts towards a budget?',
      line('Actuals include all eligible bank and cash expenses in the selected month, regardless of table search, paging or hidden chart categories. Credits and refunds are separate—not deducted from gross expenses.'),
      line('Transfers, cash reconciliations and forecasts are excluded. Parent categories include their children, so overlapping budget limits are not added into a grand total. Unspent money does not roll over.')));
  const actuals = budgetActuals(rows, state.finance, state.settings, month);
  const budgets = state.finance.bundles[state.activeSettingsName]?.budgets ?? [];
  if (!budgets.length) container.append(emptyState('Give a category a spending limit', 'Start with a category you want to keep an eye on. You can adjust a single month without changing the default.', primary('Create your first budget', () => editBudget())));
  const grid = h('div', { class: 'planning-budget-grid' });
  container.append(grid);
  for (const b of budgets) {
    const exists = b.category === 'Uncategorized' || state.settings.categories.some((c) => c.tag === b.category);
    const limit = b.months[month] ?? b.limit, actual = actuals.get(b.category) ?? 0;
    const remaining = (minor(limit) - minor(actual)) / 100;
    const progress = limit > 0 ? `${Math.round(actual / limit * 100)}% used` : actual ? 'Spending against zero budget' : 'Zero budget · no spending';
    const bar = h('progress', { class: 'h-3 w-full accent-primary', attrs: { max: '100', value: limit > 0 ? Math.min(100, actual / limit * 100) : actual ? 100 : 0, 'aria-label': `${b.category} budget used` } });
    grid.append(card(h('div', { class: 'planning-section-heading' }, h('h3', {}, b.category), badge(!exists ? 'Missing category' : b.months[month] !== undefined ? 'Month override' : 'Monthly limit', !exists ? 'warning' : '')),
      h('div', { class: 'planning-budget-values' },
        h('div', {}, h('span', { class: 'planning-eyebrow' }, 'Spent'), h('strong', {}, num2(actual))),
        h('div', {}, h('span', { class: 'planning-eyebrow' }, 'Budget'), h('strong', {}, num2(limit))),
        h('div', {}, h('span', { class: 'planning-eyebrow' }, remaining < 0 ? 'Over budget' : 'Remaining'), h('strong', { class: remaining < 0 ? 'text-danger' : 'text-success' }, num2(Math.abs(remaining))))),
      bar, line(`${progress} · CHF`),
      ...(!exists ? [line('This category no longer exists. Reassign or remove this budget.')] : []),
      h('div', { class: 'planning-actions' }, button('Edit budget', () => editBudget(b.category)),
        explanation('More options', button('Remove budget', () => run(() => updateFinance((data) => { const v = bundle(data, bundleName); v.budgets = v.budgets.filter((item) => item.category !== b.category); })))))));
  }
}

function editBudget(tag?: string): void {
  const bundleName = state.activeSettingsName;
  const current = state.finance.bundles[state.activeSettingsName]?.budgets.find((b) => b.category === tag);
  financeDialog('Monthly category budget', (body, close, guarded) => {
    const category = categorySelect(tag ?? state.settings.categories[0]?.tag ?? 'Uncategorized');
    const limit = input(String(current?.limit ?? 0), 'number');
    const override = input(current?.months[month] === undefined ? '' : String(current.months[month]), 'number');
    body.append(labeled('Category', category), labeled('Default monthly limit', limit), labeled(`Override for ${month} (blank uses default)`, override),
      button('Save budget', () => void guarded(async () => {
        const n = Number(limit.value), m = override.value === '' ? undefined : Number(override.value);
        if (!limit.value || !Number.isFinite(n) || n < 0 || (m !== undefined && (!Number.isFinite(m) || m < 0))) throw new Error('Enter non-negative limits. Zero is allowed.');
        await updateFinance((data) => {
          const v = bundle(data, bundleName);
          if (v.budgets.some((b) => b.category === category.value && b.category !== tag)) throw new Error('That category already has a budget.');
          const months = { ...current?.months }; if (m === undefined) delete months[month]; else months[month] = minor(m) / 100;
          v.budgets = [...v.budgets.filter((b) => b.category !== tag), { category: category.value, limit: minor(n) / 100, months }];
        }); close();
      })));
  });
}

function reviewView(container: HTMLElement, rows: Tx[]): void {
  const bundleName = state.activeSettingsName;
  const annotations = state.finance.bundles[state.activeSettingsName]?.annotations ?? {};
  const tags = new Set([...state.settings.categories.map((c) => c.tag), 'Uncategorized']);
  container.append(heading('Saved edits', 'Your one-off category corrections and split transactions for this category bundle.'),
    explanation('About saved edits & missing references',
      line('Edits survive reimports when transaction identities are unchanged. Files without transaction IDs or changed mappings may produce new identities; unresolved edits stay here for review.'),
      line('Missing categories or transactions are not silently replaced. Edit an existing transaction to reassign its categories, or remove a saved edit to return to category rules.')));
  const saved = Object.entries(annotations).filter(([, a]) => a.category || a.parts);
  if (!saved.length) container.append(emptyState('No saved edits yet', 'Use Edit beside a transaction to correct its category or split it across categories. Those changes will appear here.'));
  for (const [id, a] of saved) {
    const tx = rows.find((r) => r.id === id), invalid = (a.category && !tags.has(a.category)) || a.parts?.some((p) => !tags.has(p.category));
    const invalidTotal = tx && a.parts && !validSplit(tx, a.parts);
    container.append(card(h('div', { class: 'planning-actions' }, badge(a.parts ? `Split · ${a.parts.length} parts` : 'Category correction'),
      ...(!tx || invalid || invalidTotal ? [badge('Needs attention', 'warning')] : [])),
      h('h3', { class: 'planning-payment-name' }, tx ? tx.text : 'Original payment not found'),
      line(tx ? `${dmy(tx.bookingDate)} · CHF ${num2(tx.credit - tx.debit)}` : `Saved transaction ID: ${id}`),
      ...(invalid ? [line('A referenced category is missing. Edit this payment to reassign it.')] : []),
      ...(invalidTotal ? [line('The split no longer matches the original amount, so it is not being applied.')] : []),
      ...(a.parts ? [h('div', { class: 'planning-split-list' }, ...a.parts.map((p) => h('div', {}, h('span', {}, p.category), h('strong', { class: 'planning-number' }, num2(p.amount)), p.note ? line(p.note) : null)))]
        : [h('p', {}, h('span', { class: 'planning-note' }, 'Assigned category: '), h('strong', {}, a.category!))]),
      h('div', { class: 'planning-actions' }, ...(tx ? [transactionTools(tx)] : []),
        explanation('More options', button('Remove saved edit', () => run(() => updateFinance((data) => { delete bundle(data, bundleName).annotations[id]; })))))));
  }
  const missingBundles = Object.keys(state.finance.bundles).filter((name) => !state.settingsFiles.some((s) => s.name === name));
  for (const name of missingBundles) container.append(card(line(`Saved annotations/budgets for missing bundle “${name}” are retained. Recreate that bundle name to recover them, or remove explicitly.`),
    button('Remove orphaned bundle decisions', () => run(() => updateFinance((data) => { delete data.bundles[name]; })))));
}
