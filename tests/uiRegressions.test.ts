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
  get firstChild(): ElementStub | undefined { return this.children[0]; }
  removeChild(child: ElementStub): void { this.children.splice(this.children.indexOf(child), 1); }
  remove(): void { this.parent?.removeChild(this); }
  addEventListener(event: string, fn: () => void): void { (this.events[event] ??= []).push(fn); }
  getBoundingClientRect(): { width: number } { return { width: 156 }; }
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
