import { describe, expect, it } from 'vitest';
import { num2 } from '../src/ui/util';
import { shareBars, stackedBars } from '../src/ui/charts';

/** Minimal DOM stub: the chart functions only build elements via document.createElement[NS]
 *  at call time, so the rendered tree can be inspected in the node test environment. */
class StubText {
  readonly children: Array<StubEl | StubText> = [];
  constructor(readonly text: string) {}
}
class StubEl {
  readonly children: Array<StubEl | StubText> = [];
  readonly attrs: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  className = '';
  textContent = '';
  constructor(readonly tag: string) {}
  setAttribute(k: string, v: string | number): void {
    this.attrs[k] = String(v);
  }
  appendChild<C extends StubEl | StubText>(c: C): C {
    this.children.push(c);
    return c;
  }
}
(globalThis as unknown as { document: unknown }).document = {
  createElementNS: (_ns: string, tag: string) => new StubEl(tag),
  createElement: (tag: string) => new StubEl(tag),
  createTextNode: (text: string) => new StubText(text),
};

function collect(el: StubEl | StubText, tag: string): StubEl[] {
  const out: StubEl[] = [];
  if (el instanceof StubEl && el.tag === tag) out.push(el);
  for (const ch of el.children) out.push(...collect(ch, tag));
  return out;
}

const isEl = (c: StubEl | StubText): c is StubEl => c instanceof StubEl;
/** one block per top-level category (the parent row + its sub-category rows) */
const groupsOf = (el: StubEl): StubEl[] =>
  el.children.filter((c): c is StubEl => isEl(c) && c.className.includes('gap-[2px]'));
const rowsOf = (g: StubEl): StubEl[] => g.children.filter(isEl);
const cellsOf = (r: StubEl): StubEl[] => r.children.filter(isEl);

function texts(el: StubEl | StubText): string[] {
  const out: string[] = [];
  if (el instanceof StubEl) {
    if (el.textContent) out.push(el.textContent);
  } else {
    out.push(el.text);
  }
  for (const ch of el.children) out.push(...texts(ch));
  return out;
}

describe('stackedBars', () => {
  it('draws negative segments below the zero baseline (Net view)', () => {
    // regression: negative (net) values were clamped to 0 and dropped, so expense
    // categories vanished from the Monthly chart
    const wrap = stackedBars(['Jan 2026', 'Feb 2026'], [
      { name: 'Salary', color: '#3aa66b', values: [5000, 1000] },
      { name: 'Rent', color: '#d1495b', values: [-1500, -1600] },
      { name: 'Groceries', color: '#e5793a', values: [-400, -500] },
    ]) as unknown as StubEl;

    const rects = collect(wrap, 'rect');
    expect(rects).toHaveLength(6);
    for (const r of rects) expect(parseFloat(r.attrs.height)).toBeGreaterThan(0);

    // positive segments stay above the negatives, which hang below the zero line
    const posY = rects.filter((r) => r.attrs.fill === '#3aa66b').map((r) => Number(r.attrs.y));
    const negY = rects.filter((r) => r.attrs.fill === '#d1495b').map((r) => Number(r.attrs.y));
    for (const y of negY) for (const p of posY) expect(y).toBeGreaterThan(p);
    expect(collect(wrap, 'line')).toHaveLength(1); // zero baseline drawn when negatives exist

    // Feb nets to -1'100 -> the (negative) month total gets a label as well
    expect(texts(wrap).some((t) => t.startsWith('-'))).toBe(true);
  });

  it('keeps the classic bottom-up stack for all non-negative data', () => {
    const wrap = stackedBars(['Jan 2026'], [
      { name: 'Groceries', color: '#e5793a', values: [100] },
    ]) as unknown as StubEl;
    expect(collect(wrap, 'line')).toHaveLength(0);
    const r = collect(wrap, 'rect')[0];
    expect(Math.round(Number(r.attrs.y) + Number(r.attrs.height))).toBe(260 - 26); // ends at the plot bottom
    expect(texts(wrap)).toContain('100'); // total label above the bar
  });

  it('adds one invisible hit column per month when onMonthClick is given', () => {
    // spending drill-down: the whole month column is clickable, so clicking a bar
    // opens that single month's view
    const wrap = stackedBars(['Jan 2026', 'Feb 2026'], [
      { name: 'Rent', color: '#d1495b', values: [-1500, -1600] },
    ], 260, { onMonthClick: () => {} }) as unknown as StubEl;
    const rects = collect(wrap, 'rect');
    const hits = rects.filter((r) => (r.attrs.class ?? '').includes('month-hit'));
    expect(hits).toHaveLength(2); // one per month, not per segment
    // hit columns span the full plot height and sit below the segments (added first)
    expect(Number(hits[0].attrs.width)).toBeGreaterThan(0);
    expect(rects.indexOf(hits[0])).toBeLessThan(rects.indexOf(hits[1]));
    // the segments stay clickable and keep their value tooltips
    const segs = rects.filter((r) => r.attrs.fill === '#d1495b');
    expect(segs).toHaveLength(2);
    for (const s of segs) expect((s.attrs.class ?? '')).toContain('cursor-pointer');
  });

  it('draws no hit columns without onMonthClick', () => {
    const wrap = stackedBars(['Jan 2026'], [
      { name: 'Rent', color: '#d1495b', values: [-1500] },
    ]) as unknown as StubEl;
    expect(collect(wrap, 'rect').filter((r) => (r.attrs.class ?? '').includes('month-hit'))).toHaveLength(0);
  });
});

describe('shareBars', () => {
  it('lists negative categories ranked by magnitude, headline shows the signed total', () => {
    // regression: value <= 0 rows were skipped entirely (categories not displayed)
    const el = shareBars([
      { name: 'Salary', color: '#3aa66b', value: 6000 },
      { name: 'Rent', color: '#d1495b', value: -3000 },
      { name: 'Groceries', color: '#e5793a', value: -1000 },
    ], 'Net') as unknown as StubEl;

    const t = texts(el);
    expect(t).toContain('Rent');
    expect(t).toContain('60.0%');
    expect(t).toContain(num2(6000));
    expect(t).toContain('30.0%');
    expect(t).toContain(num2(-3000));
    expect(t).toContain('10.0%');
    expect(t).toContain(num2(-1000));
    expect(t).toContain(`Net: CHF ${num2(2000)}`); // headline keeps the currency
    expect(t).not.toContain(`Net: CHF ${num2(6000)}`);
  });

  it('is unchanged for non-negative data', () => {
    const el = shareBars([
      { name: 'Rent', color: '#d1495b', value: 300 },
      { name: 'Groceries', color: '#e5793a', value: 100 },
    ], 'Expenses') as unknown as StubEl;
    const t = texts(el);
    expect(t).toContain(`Expenses: CHF ${num2(400)}`);
    expect(t).toContain('75.0%');
    expect(t).toContain(num2(300));
    expect(t).toContain('25.0%');
    expect(t).toContain(num2(100));
  });

  it('gives each row a name column plus a bar track with the label on top of it', () => {
    const el = shareBars([{ name: 'Housing', color: '#4f7df9', value: 400 }], 'Expenses') as unknown as StubEl;
    const groups = groupsOf(el);
    expect(groups).toHaveLength(1);
    const rows = rowsOf(groups[0]);
    expect(rows).toHaveLength(1);
    const [name, track, pct, amount] = cellsOf(rows[0]);
    expect(name.textContent).toBe('Housing');
    expect(track.tag).toBe('div');
    // track = the colored bar + the label on top of it (label used on mobile, name column on desktop)
    const inner = cellsOf(track);
    expect(inner.map((c) => c.tag)).toEqual(['div', 'span']);
    expect(inner[1].textContent).toBe('Housing');
    expect(inner[0].style.background).toBe('#4f7df9');
    expect(inner[0].style.width).toBe('100%');
    expect(pct.textContent).toBe('100.0%');
    expect(amount.textContent).toBe(num2(400));
    // with no real layout to measure (the node test env), the fallback keeps the
    // name column at its minimum width and hides the in-bar label
    expect(rows[0].style.gridTemplateColumns).toBe('72px 1fr 48px 92px');
    expect(name.style.display).toBe('');
    expect(inner[1].style.display).toBe('none');
  });

  it('appends a detail column when items carry notes (single-month view)', () => {
    const el = shareBars([
      { name: 'Rent', color: '#d1495b', value: 300, note: '12 tx' },
      { name: 'Groceries', color: '#e5793a', value: 100, note: '8 tx' },
    ], 'Expenses') as unknown as StubEl;
    const rows = groupsOf(el).flatMap((g) => rowsOf(g));
    expect(rows).toHaveLength(2);
    const cells = cellsOf(rows[0]);
    expect(cells).toHaveLength(5); // name | bar | % | amount | note
    expect(cells[4].textContent).toBe('12 tx');
    // without layout measurements the fallback keeps the note column's 64px
    expect(rows[0].style.gridTemplateColumns).toBe('72px 1fr 48px 92px 64px');
  });

  it('hangs sub-categories in the same block as their parent', () => {
    const el = shareBars([
      { name: 'Housing', color: '#4f7df9', value: 2000, depth: 0 },
      { name: 'Rent', color: '#719cfb', value: 1850, depth: 1 },
      { name: 'Utilities', color: '#8fb1fc', value: 150, depth: 1 },
      { name: 'Groceries', color: '#b0549f', value: 300, depth: 0 },
    ], 'Expenses', { total: 2300, denominator: 2300 }) as unknown as StubEl;
    const groups = groupsOf(el);
    expect(groups).toHaveLength(2); // one block per top-level category
    expect(rowsOf(groups[0])).toHaveLength(3); // parent + its two children
    expect(rowsOf(groups[1])).toHaveLength(1);
    // percentages are relative to the denominator handed in, so parent and child never count twice
    const pctOf = (r: StubEl): string => cellsOf(r)[2].textContent;
    expect(pctOf(rowsOf(groups[0])[1])).toBe(`${((1850 / 2300) * 100).toFixed(1)}%`);
    expect(pctOf(rowsOf(groups[1])[0])).toBe(`${((300 / 2300) * 100).toFixed(1)}%`);
    // the sub-category name is indented under its parent
    expect(cellsOf(rowsOf(groups[0])[1])[0].style.paddingLeft).toBe('14px');
  });
});
