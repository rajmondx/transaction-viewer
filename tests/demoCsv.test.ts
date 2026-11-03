import { describe, expect, it } from 'vitest';
import { ABS_MAPPER } from '../src/csv/schemas';
import { parseWithMapper } from '../src/csv/parse';
import { matchTx, UNCAT } from '../src/categories/engine';
import { seedSettings } from '../src/categories/schema';
import { DEMO_FILE_NAME, demoCsv } from '../src/seed/demoCsv';

/** the demo statement is what a first-time visitor sees — it must parse and categorize */
describe('demoCsv', () => {
  const text = demoCsv(new Date('2026-10-31T12:00:00Z'));
  const { txs, missing, warnings } = parseWithMapper(text, DEMO_FILE_NAME, ABS_MAPPER);
  const settings = seedSettings();

  it('parses against the built-in schema without missing columns', () => {
    expect(missing).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    expect(txs.length).toBeGreaterThan(120);
  });

  it('is newest-first, inside six months, with a reference on every row', () => {
    const dates = txs.map((t) => t.bookingDate);
    expect([...dates].sort()).toEqual(dates.slice().reverse());
    expect(new Set(dates.map((d) => d.slice(0, 7))).size).toBe(6);
    expect(txs.every((t) => t.ref.startsWith('ZV'))).toBe(true);
    expect(txs.every((t) => t.valueDate !== '')).toBe(true);
  });

  it('has income and expense rows in the Swiss amount style', () => {
    expect(txs.some((t) => t.credit > 0)).toBe(true);
    expect(txs.some((t) => t.debit > 0)).toBe(true);
    expect(txs.filter((t) => t.credit === 0 && t.debit === 0)).toHaveLength(0);
  });

  it('keeps both legs of an internal transfer (same reference, two accounts)', () => {
    const pair = txs.filter((t) => t.text.startsWith('Transfer to savings'));
    expect(pair.length).toBeGreaterThan(2);
    const one = pair[0];
    const back = txs.find((t) => t.ref === one.ref && t.iban !== one.iban);
    expect(back).toBeDefined();
    expect(back!.credit > 0).toBe(true);
  });

  it('is in English and carries no real people or accounts', () => {
    const sample = txs.map((t) => t.text).join('\n');
    expect(sample).toMatch(/MIGROS|COOP|DENNER|ALDI|LIDL/);
    expect(sample).toMatch(/Zalando|Amazon|Galaxus|Ricardo|Temu|AliExpress|eBay/i);
    expect(sample).not.toMatch(/Xhaferi|Sadikaj|Fissneider|Migros-Club|real account/);
    expect(txs.every((t) => /^CH\d{2}\s?\d{4}/.test(t.ibanDisplay))).toBe(true);
    expect(new Set(txs.map((t) => t.iban)).size).toBe(2); // everyday + savings, both fake
  });

  it('is mostly covered by the shipped starter categories, but not entirely', () => {
    const tags = txs.map((t) => matchTx(t, settings));
    const share = tags.filter((t) => t !== UNCAT).length / tags.length;
    expect(share).toBeGreaterThan(0.65);
    expect(tags.filter((t) => t === UNCAT).length).toBeGreaterThan(3); // "Uncategorized" stays visible
    expect(new Set(tags).size).toBeGreaterThan(12);
  });
});
