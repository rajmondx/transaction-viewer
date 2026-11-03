import { describe, expect, it } from 'vitest';
import {
  buildCsvPrintDoc,
  buildSpendingPrintDoc,
  esc,
  hasTabPrintHandler,
  hatchDefs,
  mergedAmountCell,
  mergedDateCell,
  mergedDescCell,
  mergedNetTotal,
  printCss,
  setTabPrintHandler,
  shareBarsPrint,
  stackedBarsPrint,
  triggerTabPrint,
  type SpendingPrintData,
} from '../src/ui/print';

/** The print builders are pure string functions — no DOM stubs needed. */

function spendingData(over?: Partial<SpendingPrintData>): SpendingPrintData {
  return {
    title: 'Spending — default',
    meta: ['Measure: Expenses'],
    printDate: '01.01.2026',
    summary: [
      { label: 'Income', value: 'CHF 5’000.00' },
      { label: 'Expenses', value: 'CHF 3’300.00' },
    ],
    measureName: 'Expenses',
    months: ['Jan 2026', 'Feb 2026'],
    rows: [
      { name: 'Housing', depth: 0, cells: ['1’500.00', '1’600.00'], total: '3’100.00', avg: '1’550.00' },
      { name: 'Rent', depth: 1, cells: ['1’500.00', '1’600.00'], total: '3’100.00', avg: '1’550.00' },
      { name: 'Food <b>x</b>', depth: 0, cells: ['200.00', '·'], total: '200.00', avg: '100.00' },
    ],
    stacked: {
      months: ['Jan 2026', 'Feb 2026'],
      series: [
        { name: 'Housing', values: [1500, 1600] },
        { name: 'Food', values: [200, 0] },
      ],
    },
    share: {
      totalLabel: 'Expenses',
      sumLabel: 'CHF 3’300.00',
      items: [
        { name: 'Housing', value: 3100, amount: '3’100.00' },
        { name: 'Food', value: 200, amount: '200.00' },
      ],
    },
  ...over };
}

describe('esc', () => {
  it('escapes all HTML-significant characters', () => {
    expect(esc(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });
});

describe('printCss', () => {
  it('is monochrome (white paper, black ink) and monospace', () => {
    const css = printCss();
    expect(css).toContain('background: #fff');
    expect(css).toContain('color: #000');
    expect(css).toContain('ui-monospace');
    expect(css).toContain('display: table-header-group'); // headers repeat on every page
    const hexes = css.match(/#[0-9a-fA-F]{3,8}/g) ?? [];
    expect(hexes.length).toBeGreaterThan(0);
    expect(hexes.filter((c) => c !== '#fff' && c !== '#000')).toEqual([]);
  });

  it('only requests a landscape page when asked', () => {
    expect(printCss({ landscape: true })).toContain('size: A4 landscape');
    expect(printCss()).not.toContain('size: A4');
    expect(printCss({})).not.toContain('size: A4');
  });

  it('prints the totals row once — tfoot is a plain row group, not a repeating footer', () => {
    expect(printCss()).toContain('tfoot { display: table-row-group; }');
    expect(printCss()).toContain('thead { display: table-header-group; }'); // column headers keep repeating
  });

  it('applies the chosen font family and scales everything from the chosen size', () => {
    expect(printCss({ font: 'serif' })).toContain('Cambria');
    expect(printCss({ font: 'sans' })).toContain('system-ui');
    expect(printCss({ font: 'sans' })).not.toContain('Cascadia Mono');
    expect(printCss({ sizePt: 12 })).toContain('font-size: 12pt');
    expect(printCss()).toContain('font-size: 10pt'); // default
    expect(printCss({ sizePt: 12 })).toContain('h1 { font-size: 1.5em'); // relative to body
  });

  it('emits page counters only when page numbers are requested', () => {
    const css = printCss({ pageNumbers: true });
    expect(css).toContain('@bottom-center');
    expect(css).toContain('counter(page)');
    expect(css).toContain('counter(pages)');
    expect(printCss()).not.toContain('@bottom-center');
  });

  it('starts the graphs section on a page of its own', () => {
    expect(printCss()).toContain('.graphs { break-before: page; page-break-before: always; }');
  });
});

describe('hatchDefs', () => {
  it('defines all ten monochrome fill patterns', () => {
    const defs = hatchDefs();
    for (let i = 0; i < 10; i++) expect(defs).toContain(`id="hp${i}"`);
  });
});

describe('stackedBarsPrint', () => {
  it('draws one hatched rect per non-zero segment plus titles, baseline for negatives', () => {
    const svg = stackedBarsPrint(['Jan 2026', 'Feb 2026'], [
      { name: 'Salary', values: [5000, 1000] },
      { name: 'Rent', values: [-1500, -1600] },
    ]);
    expect(svg.match(/<rect/g)?.length).toBe(4 + 2); // 4 non-zero segments + 2 legend swatches
    expect(svg).toContain('<line'); // zero baseline because negatives exist
    expect(svg).toContain('fill="url(#hp0)"');
    expect(svg).toContain('fill="url(#hp1)"');
    expect(svg).toContain('Jan 2026');
    expect(svg).toContain('<title>Salary — Jan 2026: CHF 5');
    expect(svg).toContain('<div class="legend">');
  });

  it('degrades gracefully without data', () => {
    expect(stackedBarsPrint([], [])).toContain('no chart data');
  });
});

describe('shareBarsPrint', () => {
  it('ranks by magnitude, skips zero rows, signed headline, proportional text bars', () => {
    const html = shareBarsPrint([
      { name: 'Salary', value: 6000, amount: '6’000.00' },
      { name: 'Rent', value: -3000, amount: '-3’000.00' },
      { name: 'Zero', value: 0, amount: '0.00' },
    ], 'Net', 'CHF 2’000.00');
    expect(html).toContain('Net: CHF 2’000.00');
    expect(html.indexOf('>Salary<')).toBeLessThan(html.indexOf('>Rent<')); // ranked by |value|: 6000 before 3000
    expect(html).not.toContain('Zero');
    expect(html).toContain('66.7%'); // share denominator is the sum of |values| (9000)
    expect(html).toContain('█'.repeat(16)); // 66.7 % of the 24-character bar
    expect(html).toContain('█'.repeat(8)); // 33.3 % of the bar
  });

  it('caps the list at twelve categories', () => {
    const items = Array.from({ length: 13 }, (_, i) => ({ name: `Cat ${i}`, value: 100 - i, amount: '1.00' }));
    const html = shareBarsPrint(items, 'Expenses', 'CHF 1.00');
    expect((html.match(/<tr>/g) ?? []).length).toBe(12 + 1); // 12 body rows + header row
  });
});

describe('buildSpendingPrintDoc', () => {
  it('without graphs prints only the matrix (no chart markup), with escaped names', () => {
    const doc = buildSpendingPrintDoc(spendingData(), { graphs: false });
    expect(doc.startsWith('<!doctype html>')).toBe(true);
    expect(doc).toContain('<title>Spending — default</title>');
    expect(doc).toContain('Jan 2026');
    expect(doc).toContain('padding-left:22px'); // depth 1 → 6px + 16px
    expect(doc).toContain('Food &lt;b&gt;x&lt;/b&gt;');
    expect(doc).not.toContain('<script');
    expect(doc).not.toContain('url(#hp');
    expect(doc).not.toContain('█');
    expect(doc).toContain('thead');
    expect(doc).toContain('CHF 5’000.00'); // summary block
    expect(doc).toContain('<div class="head">'); // title row
    expect(doc).toContain('<div class="pdate">01.01.2026</div>'); // date top right
  });

  it('omits the header date when it was not requested', () => {
    const doc = buildSpendingPrintDoc(spendingData({ printDate: undefined }), { graphs: false });
    expect(doc).not.toContain('<div class="pdate"');
  });

  it('drops the meta and summary blocks when there is nothing to show', () => {
    const doc = buildSpendingPrintDoc(spendingData({ meta: [], summary: [] }), { graphs: false });
    expect(doc).not.toContain('<div class="meta"');
    expect(doc).not.toContain('<table class="summary"');
  });

  it('with graphs embeds the hatched SVG, legend and share text bars', () => {
    const doc = buildSpendingPrintDoc(spendingData(), { graphs: true, landscape: true });
    expect(doc).toContain('<div class="graphs">'); // graph section forced onto its own page (default)
    expect(doc).toContain('class="hatchdefs"');
    expect(doc).toContain('Monthly — Expenses');
    expect(doc).toContain('<pattern id="hp0"');
    expect(doc).toContain('<div class="legend">');
    expect(doc).toContain('█');
    expect(doc).toContain('93.9%'); // 3100 / 3300
    expect(doc).toContain('size: A4 landscape');
  });

  it('flows the graphs right after the table when the new-page toggle is off', () => {
    const doc = buildSpendingPrintDoc(spendingData(), { graphs: true, graphsNewPage: false });
    expect(doc).not.toContain('class="graphs"');
    expect(doc).toContain('Monthly — Expenses'); // charts still there, just no page break
  });

  it('has no Average column by default', () => {
    expect(buildSpendingPrintDoc(spendingData(), { graphs: false })).not.toContain('Average');
  });

  it('adds the Average column next to Total when requested, months stay', () => {
    const doc = buildSpendingPrintDoc(spendingData(), { graphs: false, average: true });
    expect(doc).toContain('<th class="num">Average</th><th class="num">Total</th>');
    expect(doc).toContain('1’550.00');
    expect(doc).toContain('100.00');
    expect(doc).toContain('Jan 2026'); // month columns untouched
  });

  it('onlyAverages leaves out the month columns but keeps Total and Average', () => {
    const doc = buildSpendingPrintDoc(spendingData(), { graphs: false, onlyAverages: true });
    expect(doc).not.toContain('Jan 2026'); // no month headers or cells (graphs off)
    expect(doc).toContain('<th class="num">Average</th><th class="num">Total</th>'); // implies the column
    expect(doc).toContain('1’550.00');
    expect(doc).toContain('3’100.00');
    expect(doc.match(/<td class="num">/g)?.length).toBe(3); // one Average cell per row — no month cells left; Total is .num.total
    expect(doc).not.toContain('<td class="num">1’500.00</td>'); // month values gone
  });

  it('has no footer rows unless one was passed', () => {
    expect(buildSpendingPrintDoc(spendingData(), { graphs: false })).not.toContain('<tfoot>');
  });

  it('prints the Total Income, Total Expenses and Total Net footer rows after the last category row', () => {
    const footer = [
      { name: 'Total Income', depth: 0, cells: ['5’000.00', '4’600.00'], total: '9’600.00', avg: '4’800.00' },
      { name: 'Total Expenses', depth: 0, cells: ['1’700.00', '1’600.00'], total: '3’300.00', avg: '1’650.00' },
      { name: 'Total Net', depth: 0, cells: ['+3’300.00', '+3’000.00'], total: '+6’300.00', avg: '+3’150.00' },
    ];
    const doc = buildSpendingPrintDoc(spendingData({ footer }), { graphs: false, average: true });
    expect(doc).toContain('<tfoot>');
    expect(doc.indexOf('<tfoot>')).toBeGreaterThan(doc.indexOf('Food &lt;b&gt;x&lt;/b&gt;')); // footer follows the body
    expect(doc.indexOf('</tfoot>')).toBeLessThan(doc.lastIndexOf('</table>')); // and closes before the matrix table does
    expect(doc).toContain('>Total Income<');
    expect(doc).toContain('>Total Expenses<');
    expect(doc).toContain('>Total Net<');
    expect(doc).toContain('+6’300.00');
    expect(doc).toContain('4’800.00'); // the Average column reaches the footer rows too
    expect((doc.match(/<tfoot>/g) ?? []).length).toBe(1);
    expect(doc.match(/<tfoot>([\s\S]*?)<\/tfoot>/)?.[1].match(/<td/g)?.length).toBe(3 * 5); // 3 rows × (name + 2 months + avg + total)
    // separating line + print-once behavior come from the shared print CSS
    expect(printCss()).toContain('tfoot { display: table-row-group; }');
    expect(printCss()).toContain('tfoot td { border-top-width: 2px; }');
  });

  it('onlyAverages keeps the footer with Average and Total only', () => {
    const doc = buildSpendingPrintDoc(spendingData({
      footer: [
        { name: 'Total Income', depth: 0, cells: ['5’000.00', '4’600.00'], total: '9’600.00', avg: '4’800.00' },
        { name: 'Total Expenses', depth: 0, cells: ['1’700.00', '1’600.00'], total: '3’300.00', avg: '1’650.00' },
        { name: 'Total Net', depth: 0, cells: ['+3’300.00', '+3’000.00'], total: '+6’300.00', avg: '+3’150.00' },
      ],
    }), { graphs: false, onlyAverages: true });
    expect(doc).toContain('<tfoot>');
    expect(doc).not.toContain('<td class="num">5’000.00</td>'); // month cells left with the columns
    expect(doc.match(/<tfoot>([\s\S]*?)<\/tfoot>/)?.[1].match(/<td/g)?.length).toBe(3 * 3); // name + avg + total
    expect(doc).toContain('4’800.00');
    expect(doc).toContain('+6’300.00');
  });

  it('drops an empty footer list', () => {
    expect(buildSpendingPrintDoc(spendingData({ footer: [] }), { graphs: false })).not.toContain('<tfoot>');
  });
});

describe('buildCsvPrintDoc', () => {
  const base = () => ({
    title: 'Transaction list',
    meta: ['Search: “rent”'],
    printDate: '01.01.2026',
    columns: [
      { key: 'date', label: 'Booking date', num: true },
      { key: 'text', label: 'Description', wrap: true },
      { key: 'debit', label: 'Debit', num: true },
    ],
    rows: [
      ['01.01.2026', 'Rent <script> & "stuff"', '1’500.00'],
      ['02.01.2026', 'Insurance', '80.00'],
    ],
    totals: { debit: '−1’580.00' } as Record<string, string>,
  });

  it('renders only the chosen columns, escaping user text, with a totals footer', () => {
    const doc = buildCsvPrintDoc(base());
    expect(doc).toContain('<title>Transaction list</title>');
    expect(doc.match(/<th[ >]/g)?.length).toBe(3); // three chosen columns (not counting <thead>)
    expect(doc.match(/<td/g)?.length).toBe(6 + 3); // 2 rows × 3 cells + tfoot
    expect(doc).toContain('class="wrap"'); // descriptions may break lines
    expect(doc).toContain('Rent &lt;script&gt; &amp; &quot;stuff&quot;');
    expect(doc).not.toContain('<script');
    expect(doc).toContain('<tfoot>');
    expect(doc).toContain('−1’580.00');
    expect(doc).toContain('>total<');
    expect(doc).toContain('Search: “rent”');
    expect(doc).toContain('<div class="pdate">01.01.2026</div>');
  });

  it('omits the footer entirely when no totals were passed', () => {
    const doc = buildCsvPrintDoc({ ...base(), totals: {} });
    expect(doc).not.toContain('<tfoot>');
  });

  it('bolds positive amounts only when the column opts in', () => {
    const doc = buildCsvPrintDoc({
      ...base(),
      columns: [{ key: 'amount', label: 'Amount', num: true, boldPositive: true }],
      rows: [['+84.30'], ['−67.89'], ['84.30'], ['']],
      totals: {},
    });
    expect(doc).toContain('<b>+84.30</b>'); // signed income
    expect(doc).toContain('<b>84.30</b>'); // plain credit amount
    expect(doc).not.toContain('<b>−67.89</b>'); // expenses stay regular
    expect(doc).not.toContain('<b></b>'); // blanks stay empty
  });

  it('keeps the line break of a merged date cell with the nl class, left-aligned', () => {
    const doc = buildCsvPrintDoc({
      ...base(),
      columns: [{ key: 'date', label: 'Date', nl: true }],
      rows: [['01.10.2026 /\n03.10.2026']],
    });
    expect(doc).toContain('class="nl"');
    expect(doc).not.toContain('class="num nl"');
    expect(doc).toContain('01.10.2026 /');
    expect(printCss()).toContain('.nl { white-space: pre-line; }');
  });
});

describe('merged cell helpers', () => {
  it('signs the merged amount column explicitly', () => {
    expect(mergedAmountCell(84.3, 0)).toBe('+84.30');
    expect(mergedAmountCell(0, 67.89)).toBe('−67.89');
    expect(mergedAmountCell(0, 0)).toBe('');
  });

  it('shows the signed net in the merged column totals row', () => {
    expect(mergedNetTotal(100, 30)).toBe('+70.00');
    expect(mergedNetTotal(0, 50)).toBe('−50.00');
    expect(mergedNetTotal(80, 80)).toBe('0.00');
  });

  it('prints merged dates once when equal, two lines when not', () => {
    expect(mergedDateCell('2026-10-01', '2026-10-01')).toBe('01.10.2026');
    expect(mergedDateCell('2026-10-01', '2026-10-03')).toBe('01.10.2026 /\n03.10.2026');
  });

  it('puts the category in front of the description', () => {
    expect(mergedDescCell('Miete Oktober', 'Housing > Rent')).toBe('Housing > Rent — Miete Oktober');
    expect(mergedDescCell('Solo', '')).toBe('Solo');
  });
});

describe('tab print handler', () => {
  it('routes the header button to the active tab and back off when cleared', () => {
    let called = 0;
    setTabPrintHandler(() => { called++; });
    expect(hasTabPrintHandler()).toBe(true);
    triggerTabPrint();
    expect(called).toBe(1);
    setTabPrintHandler(null);
    expect(hasTabPrintHandler()).toBe(false);
    triggerTabPrint(); // must not throw when no tab registered
  });
});
