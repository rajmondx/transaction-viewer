import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeSmart, parseAmount, parseCsvRecords, parseDateDE, parseWithMapper } from '../src/csv/parse';
import { ABS_MAPPER, detectSchema, guessColumns } from '../src/csv/schemas';

// committed fixture (utf-8): only the rows the tests below assert on,
// derived from a Swiss bank's Kontobewegungen export with fake accounts
const SAMPLE_PATH = fileURLToPath(new URL('../data/test.csv', import.meta.url));
const SAMPLE = fs.existsSync(SAMPLE_PATH) ? SAMPLE_PATH : undefined;

function loadSample(): string {
  const buf = fs.readFileSync(SAMPLE!);
  return decodeSmart(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

describe('decodeSmart', () => {
  it('falls back to windows-1252 when the bytes are not valid utf-8', () => {
    // "Mühlen" the way older Swiss bank exports write it: 0xFC is ü in cp1252,
    // and on its own it is not a valid UTF-8 sequence
    const bytes = Uint8Array.from([0x4d, 0xfc, 0x68, 0x6c, 0x65, 0x6e]);
    expect(decodeSmart(bytes.buffer)).toBe('Mühlen');
  });
  it.runIf(!!SAMPLE)('decodes the sample export without replacement characters', () => {
    const text = loadSample();
    expect(text).toContain('Muhlenstrasse');
    expect(text).not.toContain('\uFFFD');
  });
  it('keeps valid utf-8 intact', () => {
    const bytes = new TextEncoder().encode('Möpfel, straße éü');
    const out = decodeSmart(bytes.buffer);
    expect(out).toBe('Möpfel, straße éü');
  });
});

describe('parseCsvRecords', () => {
  it('handles quoted fields with embedded newlines and escaped quotes', () => {
    const rows = parseCsvRecords('a,b\n"x,y1\nline2","he said ""hi"""\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['x,y1\nline2', 'he said "hi"'],
    ]);
  });
  it('handles CRLF and BOM', () => {
    const rows = parseCsvRecords('\uFEFFa,b\r\nc,d\r\n');
    expect(rows).toEqual([['a', 'b'], ['c', 'd']]);
  });
});

describe('parseAmount', () => {
  it('parses swiss bank amount styles', () => {
    expect(parseAmount('CHF -500.00')).toBe(-500);
    expect(parseAmount('CHF -1,600.00')).toBe(-1600);
    expect(parseAmount('CHF 6,361.75')).toBe(6361.75);
    expect(parseAmount('CHF -12.60')).toBe(-12.6);
    expect(parseAmount('1234,56')).toBe(1234.56); // decimal comma fallback
    expect(parseAmount('')).toBeNull();
    expect(parseAmount(undefined)).toBeNull();
    expect(parseAmount('abc')).toBeNull();
  });
});

describe('parseDateDE', () => {
  it('converts DD.MM.YYYY to ISO', () => {
    expect(parseDateDE('01.10.2026')).toBe('2026-10-01');
    expect(parseDateDE('1.9.2026')).toBe('2026-09-01');
    expect(parseDateDE('31.02.2026')).toBeNull();
    expect(parseDateDE('')).toBeNull();
  });
});

describe.runIf(!!SAMPLE)('parseWithMapper on the test fixture (Alternative Bank Schweiz schema)', () => {
  const text = SAMPLE ? loadSample() : '';
  const { txs, warnings, missing } = parseWithMapper(text, 'test.csv', ABS_MAPPER);

  it('parses the data rows', () => {
    expect(txs).toHaveLength(6);
    expect(missing).toHaveLength(0);
    expect(warnings.filter((w) => !w.startsWith('row'))).toHaveLength(0);
  });

  it('maps the multi-line rent payment correctly', () => {
    const rent = txs.find((t) => t.ref === 'ZV20261001/728093');
    expect(rent).toBeDefined();
    expect(rent!.debit).toBe(1600);
    expect(rent!.credit).toBe(0);
    expect(rent!.bookingDate).toBe('2026-10-01');
    expect(rent!.hay).toContain('Miete Oktober 2026');
    expect(rent!.text).toContain('⏐'); // newline replaced for display
  });

  it('maps the income row', () => {
    const income = txs.find((t) => t.ref === 'ZV20260930/688747');
    expect(income!.credit).toBe(6361.75);
    expect(income!.debit).toBe(0);
  });

  it('keeps both halves of an internal transfer (same ref, different IBANs + signed direction)', () => {
    const pair = txs.filter((t) => t.ref === 'ZV20260813/139925');
    expect(pair).toHaveLength(2);
    // two distinct accounts and opposite money directions → two separate transactions
    expect(new Set(pair.map((p) => p.iban)).size).toBe(2);
    expect(pair.map((p) => (p.credit > 0 ? 'in' : 'out')).sort()).toEqual(['in', 'out']);
    expect(pair[0]!.id).not.toBe(pair[1]!.id);
  });

  it('produces stable ids (re-parse dedupes)', () => {
    const again = parseWithMapper(text, 'test-copy.csv', ABS_MAPPER);
    expect(again.txs.map((t) => t.id)).toEqual(txs.map((t) => t.id));
  });

  it('reports missing columns for a mismatched schema', () => {
    const res = parseWithMapper('a,b,c\n1,2,3\n', 'other.csv', ABS_MAPPER);
    expect(res.txs).toHaveLength(0);
    expect(res.missing.length).toBeGreaterThan(0);
  });
});

describe('custom mappers', () => {
  const commaText = 'Date,Description,Amount,Reference\n2026-01-05,Coffee 4.50,-4.5,R1\n2026-01-06,Salary,3200,R2\n';
  const mapper = {
    name: 'Test Bank',
    columns: { bookingDate: 'Date', text: 'Description', amount: 'Amount', txId: 'Reference' },
  };

  it('maps a single signed amount column', () => {
    const { txs, missing } = parseWithMapper(commaText, 'custom.csv', mapper);
    expect(missing).toHaveLength(0);
    expect(txs).toHaveLength(2);
    expect(txs[0]).toMatchObject({ bookingDate: '2026-01-05', credit: 0, debit: 4.5, ref: 'R1' });
    expect(txs[1]).toMatchObject({ bookingDate: '2026-01-06', credit: 3200, debit: 0 });
  });

  it('parses DD/MM/YYYY and ISO dates tolerantly', () => {
    expect(parseWithMapper('Date,Description,Amount\n05.01.2026,x,1\n2026-02-03,y,2\n', 'd.csv', {
      name: 'T', columns: { bookingDate: 'Date', text: 'Description', amount: 'Amount' },
    }).txs.map((t) => t.bookingDate)).toEqual(['2026-01-05', '2026-02-03']);
  });

  it('guesses column mappings from unknown headers', () => {
    const headers = ['Buchungsdatum', 'Buchungstext', 'Auftragsnummer', 'IBAN', 'Belastung', 'Gutschrift', 'Valutadatum'];
    const g = guessColumns(headers);
    expect(g.bookingDate).toBe('Buchungsdatum');
    expect(g.text).toBe('Buchungstext');
    expect(g.txId).toBe('Auftragsnummer');
    expect(g.iban).toBe('IBAN');
    expect(g.debit).toBe('Belastung');
    expect(g.credit).toBe('Gutschrift');
    expect(detectSchema(headers)).not.toBeNull();
  });
});
