import { describe, expect, it } from 'vitest';
import { buildCsv, csvCell, exportAmount } from '../src/ui/exportCsv';

describe('csv export helpers', () => {
  it('quotes only what needs quoting', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('with space, comma')).toBe('"with space, comma"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('')).toBe('');
  });

  it('builds CRLF rows with a trailing newline — round-trips through parseCsvRecords', async () => {
    const { parseCsvRecords } = await import('../src/csv/parse');
    const rows = [
      ['Booking date', 'Description'],
      ['01.02.2026', 'Coffee "Bean", downtown'],
      ['02.02.2026', 'multi\nline'],
    ];
    const text = buildCsv(rows);
    expect(text.endsWith('\r\n')).toBe(true);
    // quoted fields (embedded commas/quotes/newlines) come back unchanged
    expect(parseCsvRecords(text)).toEqual(rows);
  });

  it('writes amounts as plain signed numbers', () => {
    expect(exportAmount(1234.5)).toBe('1234.50');
    expect(exportAmount(-1234.5)).toBe('-1234.50');
    expect(exportAmount(0)).toBe('0.00');
    expect(exportAmount(-0.001)).toBe('0.00'); // no fake negative zero
  });
});
