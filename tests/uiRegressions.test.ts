import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A small in-memory DOM: exercise the real renderers and event handlers
 * without browser storage, layout, downloads, or an IndexedDB fixture. */
class ElementStub {
  children: ElementStub[] = [];
  attrs: Record<string, string> = {};
  style = Object.assign({} as Record<string, string>, {
    setProperty: (key: string, value: string) => { this.style[key] = value; },
  });
  dataset: Record<string, string> = {};
  events: Record<string, Array<() => void>> = {};
  value = '';
  className = '';
  textContent = '';
  parent?: ElementStub;
  oninput?: () => void;
  onchange?: () => void;
  onclick?: () => void;
  onkeydown?: (event: { key: string; preventDefault: () => void }) => void;
  onpointermove?: (event: { clientX: number }) => void;
  onpointerleave?: () => void;
  classList = { add: () => {}, remove: () => {}, toggle: () => {} };
  constructor(readonly tag: string) {}
  setAttribute(key: string, value: string): void {
    this.attrs[key] = String(value);
    if (key === 'value') this.value = String(value);
  }
  removeAttribute(key: string): void { delete this.attrs[key]; }
  appendChild(child: ElementStub): ElementStub {
    this.children.push(child);
    child.parent = this;
    return child;
  }
  append(...children: ElementStub[]): void { children.forEach((child) => this.appendChild(child)); }
  replaceChildren(...children: ElementStub[]): void { this.children = []; this.append(...children); }
  showModal(): void { this.attrs.open = 'true'; }
  close(): void { (this.events.close ?? []).forEach((fn) => fn()); }
  get firstChild(): ElementStub | undefined { return this.children[0]; }
  removeChild(child: ElementStub): void { this.children.splice(this.children.indexOf(child), 1); }
  remove(): void { this.parent?.removeChild(this); }
  addEventListener(event: string, fn: () => void): void { (this.events[event] ??= []).push(fn); }
  getBoundingClientRect(): { width: number; left: number } { return { width: 156, left: 0 }; }
  querySelector(selector: string): ElementStub | undefined {
    const fk = selector.match(/\[data-fk="([^"]+)"\]/)?.[1];
    return all(this).find((el) => el.dataset.fk === fk);
  }
  focus(): void {}
}

const all = (el: ElementStub): ElementStub[] => [el, ...el.children.flatMap(all)];
const text = (el: ElementStub): string => el.textContent + el.children.map(text).join('');
const host = (): HTMLElement => new ElementStub('host') as unknown as HTMLElement;
let body: ElementStub;

beforeEach(() => {
  vi.resetModules();
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, String(value)),
  });
  body = new ElementStub('body');
  vi.stubGlobal('document', {
    body,
    createElement: (tag: string) => new ElementStub(tag),
    createElementNS: (_ns: string, tag: string) => new ElementStub(tag),
    createTextNode: (value: string) => Object.assign(new ElementStub('#text'), { textContent: String(value) }),
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal('window', { innerWidth: 1280, addEventListener: () => {} });
  vi.stubGlobal('ResizeObserver', undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe('category editor regressions', () => {
  it('updates child parent references when a category is renamed', async () => {
    const { state } = await import('../src/state');
    const { parseSettings } = await import('../src/categories/schema');
    const { renderSettings } = await import('../src/ui/tabs/settings');
    const { getSettingsObj } = await import('../src/storage/settings');
    state.settings = parseSettings(JSON.stringify({ categories: [
      { tag: 'Housing' }, { tag: 'Rent', tag_father: 'Housing', search_tag: ['rent'] },
    ] }), 'default');
    state.settingsFiles = [{ name: 'default', isDefault: true }];
    const container = host();
    renderSettings(container);
    const elements = all(container as unknown as ElementStub);
    const input = elements.find((el) => el.dataset.fk === 'tag-0')!;
    input.value = 'Home';
    input.oninput!();
    input.events.blur[0]();
    elements.find((el) => el.tag === 'button' && text(el) === 'Save')!.events.click[0]();
    expect(getSettingsObj('default')!.categories.map((c) => [c.tag, c.tagFather]))
      .toEqual([['Home', null], ['Rent', 'Home']]);
  });
});

describe('transaction annotation UI', () => {
  async function fixture() {
    const files = await import('../src/storage/files');
    vi.spyOn(files, 'saveFinance').mockResolvedValue(undefined);
    const { state } = await import('../src/state');
    const { parseSettings } = await import('../src/categories/schema');
    const { parseWithMapper } = await import('../src/csv/parse');
    state.settings = parseSettings(JSON.stringify({ categories: [{ tag: 'Food', search_tag: ['food'] }, { tag: 'Rent', search_tag: ['rent'] }] }), 'default');
    state.txs = parseWithMapper('Date,Description,Amount\n2026-01-01,food,-100', 'bank.csv', { name: 'Custom', columns: { bookingDate: 'Date', text: 'Description', amount: 'Amount' } }).txs;
    const { openTransactionTools } = await import('../src/ui/financeTools');
    openTransactionTools(state.txs[0]);
    return { state, files, id: state.txs[0].id };
  }
  const click = (label: string) => all(body).find((el) => el.tag === 'button' && text(el) === label)!.events.click[0]();
  it('offers both requested actions and persists only the selected transaction', async () => {
    const { state, id } = await fixture();
    expect(all(body).some((el) => text(el) === 'Create a rule for similar ones')).toBe(true);
    all(body).find((el) => el.tag === 'select' && el.attrs['aria-label'] === 'Category')!.value = 'Rent';
    click('Only this transaction');
    await vi.waitFor(() => expect(state.finance.bundles.default.annotations[id].category).toBe('Rent'));
    expect(state.txs[0].debit).toBe(100);
    expect(all(body).some((el) => el.tag === 'dialog')).toBe(false);
  });
  it('does not update annotations when durable storage fails', async () => {
    const { state, files } = await fixture();
    vi.mocked(files.saveFinance).mockRejectedValueOnce(new Error('Storage full'));
    all(body).find((el) => el.tag === 'select' && el.attrs['aria-label'] === 'Category')!.value = 'Rent';
    click('Only this transaction');
    await vi.waitFor(() => expect(text(body)).toContain('Storage full'));
    expect(state.finance.bundles.default).toBeUndefined();
  });
  it('validates split totals before saving and keeps the ledger amount', async () => {
    const { state, id } = await fixture();
    click('Save split');
    await vi.waitFor(() => expect(text(body)).toContain('positive amounts'));
    const amounts = all(body).filter((el) => el.tag === 'input' && el.attrs.type === 'number');
    amounts[0].value = '40'; amounts[0].oninput!(); amounts[1].value = '60'; amounts[1].oninput!();
    click('Save split');
    await vi.waitFor(() => expect(state.finance.bundles.default.annotations[id].parts).toHaveLength(2));
    expect(state.txs[0].debit).toBe(100);
  });
  it('serializes concurrent writes and detaches editor-owned arrays', async () => {
    const { state, files } = await fixture();
    const { updateFinance } = await import('../src/state');
    let release!: () => void;
    vi.mocked(files.saveFinance).mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const edited = ['first'];
    const first = updateFinance((data) => { data.rejectedTransfers = edited; });
    const second = updateFinance((data) => { data.rejectedTransfers.push('second'); });
    await vi.waitFor(() => expect(files.saveFinance).toHaveBeenCalledTimes(1));
    edited.push('not committed'); release();
    await Promise.all([first, second]);
    expect(state.finance.rejectedTransfers).toEqual(['first', 'second']);
  });
});

describe('Planning readability and navigation', () => {
  async function fixture() {
    const files = await import('../src/storage/files');
    vi.spyOn(files, 'saveFinance').mockResolvedValue(undefined);
    const { state } = await import('../src/state');
    const { parseSettings } = await import('../src/categories/schema');
    const { parseWithMapper } = await import('../src/csv/parse');
    const { detectRecurring } = await import('../src/finance/recurring');
    const { renderFinance } = await import('../src/ui/tabs/finance');
    state.settings = parseSettings(JSON.stringify({ categories: [{ tag: 'Bills', search_tag: ['subscription'] }] }), 'default');
    state.settingsFiles = [{ name: 'default', isDefault: true }];
    const rows = ['Active subscription', 'Suggested subscription', 'Archived subscription'].flatMap((name) =>
      ['2026-01-01', '2026-02-01', '2026-03-01'].map((date) => `${date},${name},-10`));
    state.txs = parseWithMapper(`Date,Description,Amount\n${rows.join('\n')}`, 'bank.csv', { name: 'Custom', columns: { bookingDate: 'Date', text: 'Description', amount: 'Amount' } }).txs;
    const detected = detectRecurring(state.txs);
    state.finance.series = detected.filter((s) => !s.name.startsWith('suggested')).map((s) => ({
      id: s.id, name: s.name, txIds: s.rows.map((r) => r.id), keys: s.keys, cadence: s.cadence, variable: false,
      status: s.name.startsWith('archived') ? 'dismissed' as const : 'confirmed' as const,
    }));
    const render = () => { const root = host(); renderFinance(root); return root as unknown as ElementStub; };
    return { state, render };
  }

  it('separates active bills from suggestions and keeps explanations collapsed', async () => {
    const { render } = await fixture();
    const root = render(), elements = all(root);
    const metrics = elements.filter((el) => el.className === 'planning-metric');
    expect(metrics).toHaveLength(3);
    expect(text(metrics[0])).toContain('10.00');
    expect(text(metrics[0])).not.toContain('30.00');
    expect(text(root)).toContain('Active bills'); expect(text(root)).toContain('Suggestions');
    const cards = elements.filter((el) => el.className === 'planning-item');
    expect(cards).toHaveLength(2);
    expect(cards.some((el) => text(el).includes('Archived subscription'))).toBe(false);
    expect(elements.filter((el) => el.tag === 'details').every((el) => !el.attrs.open)).toBe(true);
    expect(elements.some((el) => el.attrs['aria-label'] === 'Search recurring payments')).toBe(true);
  });

  it('searches payments without changing stored names or hiding archived access', async () => {
    const { render, state } = await fixture();
    let root = render();
    const search = all(root).find((el) => el.attrs['aria-label'] === 'Search recurring payments')!;
    search.value = 'Suggested'; search.oninput!(); root = render();
    expect(all(root).filter((el) => el.className === 'planning-item')).toHaveLength(1);
    const filter = all(root).find((el) => el.attrs['aria-label'] === 'Recurring payment status')!;
    search.value = ''; search.oninput!(); filter.value = 'archived'; filter.onchange!(); root = render();
    expect(text(root)).toContain('Archived subscription');
    expect(all(root).some((el) => el.tag === 'button' && text(el) === 'Reactivate')).toBe(true);
    expect(state.finance.series.find((s) => s.status === 'dismissed')?.name).toBe('archived subscription');
  });

  it('keeps suggestion confirmation functional in the compact layout', async () => {
    const { render, state } = await fixture();
    const root = render();
    const confirm = all(root).find((el) => el.tag === 'button' && text(el) === 'Confirm')!;
    confirm.events.click[0]();
    await vi.waitFor(() => expect(state.finance.series.filter((s) => s.status === 'confirmed')).toHaveLength(2));
  });

  it('navigates to transfers, budgets and saved edits with clear empty states', async () => {
    const { render } = await fixture();
    let root = render();
    for (const [key, expected] of [['transfers', 'No transfers to review'], ['budgets', 'Give a category a spending limit'], ['review', 'No saved edits yet']]) {
      all(root).find((el) => el.dataset.fk === `planning-nav-${key}`)!.events.click[0]();
      root = render();
      expect(text(root)).toContain(expected);
      expect(all(root).find((el) => el.dataset.fk === `planning-nav-${key}`)?.attrs['aria-current']).toBe('page');
    }
  });
});

describe('stored mapper snapshots', () => {
  it('does not substitute an edited registry mapper when opening remap', async () => {
    const { saveMapper } = await import('../src/storage/mappers');
    const { openUploadModal } = await import('../src/ui/uploadModal');
    const columns = { bookingDate: 'Date', text: 'Description', amount: 'OldAmount' };
    saveMapper({ name: 'My Bank', columns: { ...columns, amount: 'NewAmount' } });
    openUploadModal([{
      name: 'bank.csv', mapper: { name: 'My Bank', columns },
      content: 'Date,Description,OldAmount,NewAmount\n2026-01-01,Payment,-10,-900',
    }], 'remap');
    const cells = all(body).filter((el) => el.tag === 'td').map(text);
    expect(cells).toContain('−10.00');
    expect(cells).not.toContain('−900.00');
    const schema = all(body).find((el) => el.tag === 'select' && el.value === '__custom')!;
    expect(schema).toBeDefined();
    // An explicit preset selection is still allowed to replace the snapshot.
    schema.value = 'My Bank';
    schema.onchange!();
    expect(all(body).filter((el) => el.tag === 'td').map(text)).toContain('−900.00');
  });
});

describe('spending chart exclusions', () => {
  it.each([
    { hidden: 'Rent', expected: '70.00', housing: '50.00', matrix: '100.00' },
    { hidden: 'Housing', expected: '120.00', housing: '100.00', matrix: '150.00' },
  ])('excludes $hidden own assignments without hiding selected descendants', async ({ hidden, expected, housing, matrix }) => {
    const { state } = await import('../src/state');
    const { parseSettings } = await import('../src/categories/schema');
    const { parseWithMapper } = await import('../src/csv/parse');
    const { renderSpending } = await import('../src/ui/tabs/spending');
    state.settings = parseSettings(JSON.stringify({ categories: [
      { tag: 'Housing', search_tag: ['mortgage'] }, { tag: 'Rent', tag_father: 'Housing', search_tag: ['rent'] },
      { tag: 'Food', search_tag: ['food'] },
    ] }), 'default');
    state.files = [{ name: 'bank.csv', rows: 3, mapper: 'Custom' }];
    state.txs = parseWithMapper('Date,Description,Amount\n2026-01-01,rent,-100\n2026-01-02,food,-20\n2026-01-03,mortgage,-50', 'bank.csv', {
      name: 'Custom', columns: { bookingDate: 'Date', text: 'Description', amount: 'Amount' },
    }).txs;
    state.spendingView.hiddenCats = [hidden];
    const container = host();
    renderSpending(container);
    const elements = all(container as unknown as ElementStub);
    expect(elements.some((el) => el.textContent === `Expenses: CHF ${expected}`)).toBe(true);
    expect(elements.some((el) => el.textContent === 'Expenses: CHF 170.00')).toBe(false);
    expect(elements.filter((el) => el.tag === 'title').map(text)).toContain(`Housing — Jan 2026: CHF ${housing}`);
    expect(elements.some((el) => el.tag === 'tr' && el.className.includes('opacity-40') && text(el).includes(matrix))).toBe(true);
  });
});

describe('shared balance chart', () => {
  async function fixture(csv = 'Date,Description,Amount\n2026-01-01,salary,100\n2026-02-02,food,-20\n2026-03-03,food,-10') {
    const { balanceSummary } = await import('../src/ui/balanceChart');
    const { emptySettings } = await import('../src/categories/schema');
    const { parseWithMapper } = await import('../src/csv/parse');
    const txs = parseWithMapper(csv, 'test.csv', {
      name: 'Custom', columns: { bookingDate: 'Date', text: 'Description', amount: 'Amount' },
    }).txs;
    const root = balanceSummary(txs, [], emptySettings('test'), 10) as unknown as ElementStub;
    const get = (fk: string) => all(root).find((el) => el.dataset.fk === fk)!;
    const click = (fk: string) => get(fk).events.click.forEach((fn) => fn());
    const panel = () => all(root).find((el) => el.attrs.id === 'balance-history-panel')!;
    return { root, get, click, panel };
  }

  it('opens one chart, toggles multiple series from cards or legend, and closes on the last deselection', async () => {
    const { root, get, click, panel } = await fixture();
    expect(panel().children).toHaveLength(0);
    click('balance-total');
    expect(get('balance-total').attrs['aria-pressed']).toBe('true');
    expect(all(root).filter((el) => el.tag === 'svg' && el.attrs['aria-label']?.startsWith('Balance history chart'))).toHaveLength(1);
    click('balance-cash'); click('balance-bank');
    expect(get('balance-legend-cash').attrs['aria-pressed']).toBe('true');
    expect(all(root).filter((el) => el.tag === 'circle' && el.attrs.r === '3.5')).toHaveLength(3);
    click('balance-legend-total');
    expect(get('balance-total').attrs['aria-pressed']).toBe('false');
    expect(all(root).filter((el) => el.tag === 'circle' && el.attrs.r === '3.5')).toHaveLength(2);
    click('balance-cash'); click('balance-bank');
    expect(panel().children).toHaveLength(0);
  });

  it('shares spacing and date ranges across series and supports keyboard date inspection', async () => {
    const { root, get, click } = await fixture();
    click('balance-total'); click('balance-bank');
    for (const spacing of ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Yearly']) {
      click(`balance-spacing-${spacing}`);
      expect(get(`balance-spacing-${spacing}`).attrs['aria-pressed']).toBe('true');
    }
    click('balance-spacing-Daily');
    click('balance-range-1M');
    expect(get('balance-from').attrs.value).toBe('2026-02-03');
    const svg = all(root).find((el) => el.tag === 'svg' && el.attrs['aria-label']?.startsWith('Balance history chart'))!;
    const preventDefault = vi.fn();
    svg.onkeydown!({ key: 'Home', preventDefault });
    expect(text(root)).toContain('03.02.2026');
    expect(text(root)).toContain('Total balance: Δ CHF 90.00');
    expect(text(root)).toContain('Bank balance: Δ CHF 80.00');
    svg.onkeydown!({ key: 'End', preventDefault });
    expect(text(root)).toContain('Total balance: Δ CHF 80.00');
    expect(preventDefault).toHaveBeenCalledTimes(2);
  });

  it('handles invalid custom ranges, preserves choices across renders, and resets series on close', async () => {
    const { root, get, click } = await fixture();
    click('balance-cash'); click('balance-spacing-Quarterly');
    get('balance-from').value = '2026-03-03'; get('balance-from').onchange!();
    get('balance-to').value = '2026-01-01'; get('balance-to').onchange!();
    expect(text(root)).toContain('Choose a From date on or before the To date.');
    get('balance-to').value = '9999-01-01'; get('balance-to').onchange!();
    expect(text(root)).toContain('Choose dates within available history:');
    const rerendered = await fixture();
    expect(rerendered.get('balance-cash').attrs['aria-pressed']).toBe('true');
    expect(rerendered.get('balance-spacing-Quarterly').attrs['aria-pressed']).toBe('true');
    all(rerendered.root).find((el) => el.attrs['aria-label'] === 'Close balance chart')!.events.click.forEach((fn) => fn());
    expect(rerendered.panel().children).toHaveLength(0);
    expect(rerendered.get('balance-cash').attrs['aria-pressed']).toBe('false');
  });

  it('shows an empty state without dated data', async () => {
    const { balanceSummary } = await import('../src/ui/balanceChart');
    const { emptySettings } = await import('../src/categories/schema');
    const root = balanceSummary([], [], emptySettings('test'), 10) as unknown as ElementStub;
    all(root).find((el) => el.dataset.fk === 'balance-cash')!.events.click.forEach((fn) => fn());
    expect(text(root)).toContain('No dated transactions to chart yet.');
  });
});

describe('Spending summary timeline', () => {
  async function fixture(hiddenMonths: string[] = []) {
    const { spendingSummary } = await import('../src/ui/spendingSummary');
    const { buildSpendingDays, sumSpending } = await import('../src/spendingHistory');
    const { parseWithMapper } = await import('../src/csv/parse');
    const rows = parseWithMapper('Date,Description,Amount\n2026-01-01,salary,100\n2026-01-02,food,-60\n2026-02-10,unknown,-40\n2026-02-15,salary,200', 'test.csv', {
      name: 'Custom', columns: { bookingDate: 'Date', text: 'Description', amount: 'Amount' },
    }).txs;
    const assignments = new Map([
      ['Income', rows.filter((row) => row.text === 'salary')],
      ['Food', rows.filter((row) => row.text === 'food')],
      ['Uncategorized', rows.filter((row) => row.text === 'unknown')],
    ]);
    const months = ['2026-01', '2026-02'].filter((month) => !hiddenMonths.includes(month));
    const totals = sumSpending(buildSpendingDays(assignments, [], months, 'Corrections'));
    const root = spendingSummary({
      totals, txByTag: assignments, scopeRows: rows, hiddenCats: [], hiddenMonths, visibleMonths: months,
      reconciliationCategory: 'Corrections', dateFrom: '', dateTo: '',
    }) as unknown as ElementStub;
    const get = (fk: string) => all(root).find((el) => el.dataset.fk === fk)!;
    const click = (fk: string) => get(fk).events.click.forEach((fn) => fn());
    const svg = () => all(root).find((el) => el.tag === 'svg' && el.attrs['aria-label']?.startsWith('Spending summary timeline'))!;
    const readout = () => text(all(root).find((el) => 'data-spending-readout' in el.attrs)!);
    return { root, get, click, svg, readout };
  }

  it('toggles money lines, transaction bars and coverage inside one shared SVG', async () => {
    const { root, get, click, svg } = await fixture();
    expect(svg()).toBeUndefined();
    for (const key of ['income', 'expenses', 'net', 'transactions', 'categorized']) click(`spending-summary-${key}`);
    expect(all(root).filter((el) => el.tag === 'svg' && el.attrs['aria-label']?.startsWith('Spending summary timeline'))).toHaveLength(1);
    expect(all(svg()).filter((el) => el.attrs['data-lane']).map((el) => el.attrs['data-lane'])).toEqual(['money', 'transactions', 'categorized']);
    const initialHeight = Number(svg().attrs.height);
    click('summary-legend-transactions');
    expect(get('spending-summary-transactions').attrs['aria-pressed']).toBe('false');
    expect(Number(svg().attrs.height)).toBeLessThan(initialHeight);
    expect(all(svg()).some((el) => el.attrs['data-lane'] === 'transactions')).toBe(false);
    for (const key of ['income', 'expenses', 'net', 'categorized']) click(`spending-summary-${key}`);
    expect(svg()).toBeUndefined();
  });

  it('supports count-only and coverage-only charts without a money axis', async () => {
    const { click, svg, readout } = await fixture();
    click('spending-summary-transactions');
    expect(all(svg()).filter((el) => el.attrs['data-lane']).map((el) => el.attrs['data-lane'])).toEqual(['transactions']);
    expect(readout()).toContain('Transactions: 4');
    click('spending-summary-categorized'); click('spending-summary-transactions');
    expect(all(svg()).filter((el) => el.attrs['data-lane']).map((el) => el.attrs['data-lane'])).toEqual(['categorized']);
    expect(readout()).toContain('Categorized: 60.0%');
    expect(readout()).toContain('CHF 40.00 uncategorized');
  });

  it('synchronizes hover and keyboard readouts and restores weighted range totals', async () => {
    const { click, svg, readout } = await fixture();
    for (const key of ['income', 'expenses', 'net', 'transactions', 'categorized']) click(`spending-summary-${key}`);
    const key = (value: string) => svg().onkeydown!({ key: value, preventDefault: () => {} });
    key('Home');
    expect(readout()).toContain('01.01.2026 – 31.01.2026');
    expect(readout()).toContain('Income: CHF 100.00');
    expect(readout()).toContain('Expenses: CHF 60.00');
    expect(readout()).toContain('Net: CHF 40.00');
    expect(readout()).toContain('Transactions: 2');
    expect(readout()).toContain('Categorized: 100.0%');
    key('End');
    expect(readout()).toContain('Categorized: 0.0%');
    key('Escape');
    expect(readout()).toContain('Selected range');
    expect(readout()).toContain('Categorized: 60.0%');
    svg().onpointermove!({ clientX: 156 });
    expect(readout()).toContain('01.02.2026 – 15.02.2026');
    svg().onpointerleave!();
    expect(readout()).toContain('Selected range');
    expect(readout()).toContain('Transactions: 4');
  });

  it('shares all five spacing choices, custom ranges and presets without changing report cards', async () => {
    const { get, click, svg, readout } = await fixture();
    click('spending-summary-income'); click('spending-summary-transactions');
    for (const spacing of ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Yearly']) {
      click(`summary-spacing-${spacing}`);
      expect(get(`summary-spacing-${spacing}`).attrs['aria-pressed']).toBe('true');
    }
    expect(all(svg()).some((el) => el.tag === 'circle' && el.attrs.r === '3')).toBe(true); // one yearly point
    click('summary-range-1M');
    expect(get('summary-from').attrs.value).toBe('2026-01-15');
    expect(readout()).toContain('Income: CHF 200.00');
    expect(text(get('spending-summary-income'))).toContain('CHF 300.00');
    get('summary-from').value = '2026-02-15'; get('summary-from').onchange!();
    get('summary-to').value = '2026-01-01'; get('summary-to').onchange!();
    expect(svg()).toBeUndefined();
    get('summary-to').value = '9999-01-01'; get('summary-to').onchange!();
    expect(svg()).toBeUndefined();
    click('summary-range-All');
    expect(readout()).toContain('Income: CHF 300.00');
  });

  it('keeps hidden months as gaps and can close the whole panel', async () => {
    const { root, click, svg, readout } = await fixture(['2026-01']);
    click('spending-summary-income'); click('spending-summary-categorized');
    svg().onkeydown!({ key: 'Home', preventDefault: () => {} });
    expect(readout()).toContain('Hidden by month filters');
    svg().onkeydown!({ key: 'End', preventDefault: () => {} });
    expect(readout()).toContain('Income: CHF 200.00');
    all(root).find((el) => el.attrs['aria-label'] === 'Close spending summary chart')!.events.click.forEach((fn) => fn());
    expect(svg()).toBeUndefined();
  });

  it('shows an empty state for reports without dated rows', async () => {
    const { spendingSummary } = await import('../src/ui/spendingSummary');
    const { emptySpendingTotals } = await import('../src/spendingHistory');
    const root = spendingSummary({
      totals: emptySpendingTotals(), txByTag: new Map(), scopeRows: [], hiddenCats: [], hiddenMonths: [],
      visibleMonths: [], reconciliationCategory: 'Corrections', dateFrom: '', dateTo: '',
    }) as unknown as ElementStub;
    all(root).find((el) => el.dataset.fk === 'spending-summary-categorized')!.events.click.forEach((fn) => fn());
    expect(text(root)).toContain('No dated transactions in the current Spending filters.');
    expect(text(root)).toContain('No expenses');
  });

  it('matches the real Spending source, category, month and cash-transfer filters', async () => {
    const { state } = await import('../src/state');
    const { emptySettings } = await import('../src/categories/schema');
    const { parseWithMapper } = await import('../src/csv/parse');
    const { renderSpending } = await import('../src/ui/tabs/spending');
    const { money } = await import('../src/ui/util');
    state.settings = emptySettings('test');
    for (const tag of ['Food', 'ATM']) state.settings.categories.push({
      tag, tagFather: null, color: '#123456', ibans: [], dateFrom: null, dateTo: null, enabled: true,
      rules: [{ text: tag.toLowerCase(), caseSensitive: false, fuzzy: false, regex: false }],
      ...(tag === 'ATM' ? { cashMovement: 'withdrawal' as const } : {}),
    });
    state.files = [{ name: 'test.csv', rows: 3, mapper: 'Custom' }];
    state.txs = parseWithMapper('Date,Description,Amount\n2026-01-01,salary,1000\n2026-01-02,atm,-100\n2026-01-03,food,-40', 'test.csv', {
      name: 'Custom', columns: { bookingDate: 'Date', text: 'Description', amount: 'Amount' },
    }).txs;
    state.cashEntries = [
      { id: 'cash', date: '2026-01-04', kind: 'expense', amount: 12, category: 'Food', note: '' },
      { id: 'adjust', date: '2026-01-05', kind: 'adjustment', amount: -2, category: '', note: '' },
    ];
    const container = host() as unknown as ElementStub;
    const render = () => renderSpending(container as unknown as HTMLElement);
    const click = (key: string) => all(container).find((el) => el.dataset.fk === `spending-summary-${key}`)!.events.click.forEach((fn) => fn());
    const readout = () => text(all(container).find((el) => 'data-spending-readout' in el.attrs)!);
    render(); click('income'); click('expenses'); click('transactions'); click('categorized');
    expect(readout()).toContain(`Income: ${money(1000)}`);
    expect(readout()).toContain('Expenses: CHF 54.00'); // ATM excluded, corrections included
    expect(readout()).toContain('Transactions: 4');
    expect(readout()).toContain('Categorized: 96.3%'); // 52 / 54
    state.spendingView.source = 'bank'; render();
    expect(readout()).toContain('Expenses: CHF 40.00');
    expect(readout()).toContain('Transactions: 2');
    state.spendingView.cashInSpending = ['ATM']; render();
    expect(readout()).toContain('Expenses: CHF 140.00');
    expect(readout()).toContain('Transactions: 3');
    state.spendingView.cashInSpending = [];
    state.spendingView.source = 'cash'; render();
    expect(readout()).toContain('Expenses: CHF 14.00');
    expect(readout()).toContain('Transactions: 2');
    state.spendingView.hiddenCats = ['Food']; render();
    expect(readout()).toContain('Expenses: CHF 2.00');
    expect(readout()).toContain('Transactions: 1');
    state.spendingView.hiddenMonths = ['2026-01']; render();
    expect(readout()).toContain('Expenses: CHF 0.00');
    expect(readout()).toContain('Categorized: No expenses');
    state.spendingView.hiddenMonths = [];
    state.spendingView.hiddenCats = [];
    state.spendingView.dateFrom = '2026-01-05'; render();
    expect(readout()).toContain('Expenses: CHF 2.00');
    expect(readout()).toContain('Transactions: 1');
  });
});

describe('Share category trends', () => {
  async function fixture(options: { subs?: boolean; measure?: 'expense' | 'income' | 'net'; hiddenCats?: string[]; hiddenMonths?: string[] } = {}) {
    const { categoryTrends } = await import('../src/ui/categoryTrends');
    const { parseSettings } = await import('../src/categories/schema');
    const { aggregate, buildTree } = await import('../src/categories/engine');
    const { parseWithMapper } = await import('../src/csv/parse');
    const settings = parseSettings(JSON.stringify({ categories: [
      { tag: 'Housing' }, { tag: 'Rent', tag_father: 'Housing', search_tag: ['rent'] },
      { tag: 'Utilities', tag_father: 'Rent', search_tag: ['utility'] },
      { tag: 'Food', search_tag: ['food'] }, { tag: 'Salary', search_tag: ['salary'] },
      ...Array.from({ length: 13 }, (_, i) => ({ tag: `Extra ${i}` })),
    ] }), 'test');
    const rows = parseWithMapper('Date,Description,Amount\n2026-01-01,salary,1000\n2026-01-02,rent,-80\n2026-01-03,utility,-20\n2026-01-04,food,-100\n2026-02-01,rent,-100\n2026-02-02,food,-100', 'test.csv', {
      name: 'Custom', columns: { bookingDate: 'Date', text: 'Description', amount: 'Amount' },
    }).txs;
    const agg = aggregate(rows, settings), roots = buildTree(settings);
    const measure = options.measure ?? 'expense';
    const amount = (tag: string) => {
      const a = agg.subtree.get(tag)!;
      return measure === 'expense' ? a.debit : measure === 'income' ? a.credit : a.credit - a.debit;
    };
    const root = categoryTrends({
      items: [
        { name: 'Housing', color: '#5577aa', value: amount('Housing') },
        ...(options.subs === false ? [] : [{ name: 'Rent', color: '#5577aa', value: amount('Rent'), depth: 1 }]),
        { name: 'Food', color: '#55aa77', value: amount('Food') },
      ], measure, measureName: measure === 'expense' ? 'Expenses' : measure === 'income' ? 'Income' : 'Net',
      total: roots.reduce((sum, root) => sum + amount(root.tag), 0),
      denominator: roots.reduce((sum, root) => sum + Math.abs(amount(root.tag)), 0),
      roots, txByTag: agg.txByTag, scopeRows: rows, hiddenCats: options.hiddenCats ?? [],
      visibleMonths: ['2026-01', '2026-02'].filter((month) => !options.hiddenMonths?.includes(month)), hiddenMonths: options.hiddenMonths ?? [], dateFrom: '', dateTo: '',
    }) as unknown as ElementStub;
    const get = (fk: string) => all(root).find((el) => el.dataset.fk === fk)!;
    const click = (fk: string) => get(fk).events.click.forEach((fn) => fn());
    const row = (tag: string) => all(root).find((el) => el.attrs['data-category'] === tag)!;
    const selectRow = (tag: string) => row(tag).onclick!();
    const add = (tag: string) => { get('category-picker').value = tag; get('category-picker').onchange!(); };
    const svg = () => all(root).find((el) => el.tag === 'svg' && el.attrs['aria-label']?.startsWith('Category trends in'))!;
    const readout = () => text(all(root).find((el) => 'data-category-readout' in el.attrs)!);
    return { root, get, click, row, selectRow, add, svg, readout };
  }

  it('toggles categories and subcategories into one chart with active rows and removable path labels', async () => {
    const { root, row, selectRow, click, svg, readout } = await fixture();
    expect(svg()).toBeUndefined();
    selectRow('Housing'); selectRow('Rent');
    expect(row('Housing').attrs['aria-pressed']).toBe('true');
    expect(row('Rent').attrs['aria-pressed']).toBe('true');
    expect(all(svg()).filter((el) => el.attrs['data-category-line']).map((el) => el.attrs['data-category-line'])).toEqual(['Housing', 'Rent']);
    expect(readout()).toContain('Housing: CHF 200.00');
    expect(readout()).toContain('Housing › Rent: CHF 200.00');
    expect(text(root)).toContain('parent and child lines overlap');
    click('category-remove-Rent');
    expect(row('Rent').attrs['aria-pressed']).toBe('false');
    selectRow('Housing');
    expect(svg()).toBeUndefined();
  });

  it('adds deep, zero-valued and non-top-12 categories from the picker and retains lines when subcategories disappear', async () => {
    const { root, add, svg, readout } = await fixture();
    expect(text(root)).toContain('Extra 12');
    add('Utilities'); add('Extra 12');
    expect(readout()).toContain('Housing › Rent › Utilities: CHF 20.00');
    expect(readout()).toContain('Extra 12: CHF 0.00');
    expect(all(svg()).filter((el) => el.attrs['data-category-line'])).toHaveLength(2);
    const rerendered = await fixture({ subs: false });
    expect(rerendered.row('Rent')).toBeUndefined();
    expect(rerendered.readout()).toContain('Housing › Rent › Utilities');
    rerendered.click('category-clear');
    expect(rerendered.svg()).toBeUndefined();
  });

  it('switches CHF and % without changing the all-category denominator and preserves signed Net readouts', async () => {
    const { selectRow, click, readout, svg } = await fixture();
    selectRow('Housing'); click('category-unit-%');
    expect(readout()).toContain('Housing: 50.00% · CHF 200.00');
    selectRow('Food');
    expect(readout()).toContain('Housing: 50.00%');
    expect(readout()).toContain('Food: 50.00%');
    expect(svg().attrs['aria-label']).toContain('Category trends in %');
    const net = await fixture({ measure: 'net' });
    expect(net.readout()).toContain('Housing: 14.29% · CHF -200.00');
    net.click('category-unit-CHF');
    expect(net.readout()).toContain('Housing: CHF -200.00 · 14.29%');
    net.svg().onkeydown!({ key: 'Home', preventDefault: () => {} });
    expect(net.readout()).toContain('Housing: CHF -100.00');
  });

  it('shares all spacings and dates and synchronizes keyboard, pointer and range readouts', async () => {
    const { selectRow, click, get, svg, readout } = await fixture();
    selectRow('Housing'); selectRow('Food');
    for (const spacing of ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Yearly']) {
      click(`category-spacing-${spacing}`);
      expect(get(`category-spacing-${spacing}`).attrs['aria-pressed']).toBe('true');
    }
    expect(all(svg()).some((el) => el.tag === 'circle' && el.attrs.r === '3')).toBe(true);
    click('category-spacing-Monthly');
    svg().onkeydown!({ key: 'Home', preventDefault: () => {} });
    expect(readout()).toContain('01.01.2026 – 31.01.2026');
    expect(readout()).toContain('Housing: CHF 100.00');
    svg().onpointermove!({ clientX: 156 });
    expect(readout()).toContain('01.02.2026 – 02.02.2026');
    svg().onpointerleave!();
    expect(readout()).toContain('Selected range');
    click('category-range-1M');
    expect(get('category-from').attrs.value).toBe('2026-01-02');
    get('category-from').value = '2026-02-02'; get('category-from').onchange!();
    expect(readout()).toContain('Housing: CHF 0.00');
    get('category-to').value = '2026-01-01'; get('category-to').onchange!();
    expect(svg()).toBeUndefined();
    get('category-to').value = '9999-01-01'; get('category-to').onchange!();
    expect(svg()).toBeUndefined();
    click('category-range-All');
    expect(readout()).toContain('Housing: CHF 200.00');
  });

  it('keeps hidden-month gaps and hidden-category rollups consistent with the report', async () => {
    const { selectRow, svg, readout } = await fixture({ hiddenCats: ['Rent'], hiddenMonths: ['2026-02'] });
    selectRow('Housing');
    expect(readout()).toContain('Housing: CHF 20.00'); // Utilities remains selected below hidden Rent
    svg().onkeydown!({ key: 'End', preventDefault: () => {} });
    expect(readout()).toContain('Hidden by month filters');
    const path = all(svg()).find((el) => el.attrs['data-category-line'] === 'Housing')!;
    expect(path.attrs.d).not.toContain('L');
  });

  it('reports percentage gaps when the current measure has no denominator', async () => {
    const { add, click, svg, readout } = await fixture({ measure: 'income' });
    add('Salary'); click('category-unit-%');
    svg().onkeydown!({ key: 'End', preventDefault: () => {} });
    expect(readout()).toContain('Share unavailable (zero total)');
    svg().onkeydown!({ key: 'Home', preventDefault: () => {} });
    expect(readout()).toContain('Salary: 100.00%');
    svg().onkeydown!({ key: 'Escape', preventDefault: () => {} });
    expect(readout()).toContain('Selected range');
  });
});
