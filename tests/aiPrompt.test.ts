import { describe, expect, it } from 'vitest';
import type { Tx } from '../src/types';
import { AI_LINE_LIMIT, buildAiPrompt, compactText, renderLines, similarity, simplifyTxs } from '../src/categories/aiPrompt';
import { emptySettings, parseSettings } from '../src/categories/schema';

function tx(partial: Partial<Tx>): Tx {
  return {
    id: 'x', file: 'f.csv', row: 1, bookingDate: '2026-10-05', valueDate: '2026-10-05', ref: 'R',
    account: 'A', accountAlias: 'A', iban: 'CH450470000000123456', ibanDisplay: 'CH45 0470 0000 0012 3456',
    text: 'Debit card 05.10.2026 18:04 MIGROS ZURICH', hay: 'Debit card 05.10.2026 18:04 MIGROS ZURICH',
    credit: 0, debit: 24.5, ...partial,
  };
}

const many = (n: number, over: Partial<Tx> = {}): Tx[] =>
  Array.from({ length: n }, (_, i) => tx({ ...over, ref: `R${i}`, row: i + 1 }));

describe('similarity', () => {
  it('treats the same payee with a different date as identical', () => {
    const a = 'Debit card 05.10.2026 18:04 MIGROS ZURICH';
    const b = 'Debit card 12.03.2026 09:31 MIGROS ZURICH';
    expect(similarity(a, b)).toBeGreaterThanOrEqual(0.5);
  });
  it('keeps different payees apart', () => {
    expect(similarity('SBB CFF FFS ticket Zurich-Bern', 'Amavita pharmacy Zurich')).toBeLessThan(0.5);
  });
  it('ignores number-like tokens (dates, amounts, card numbers)', () => {
    expect(similarity('TWINT 12.50 to Bakery', 'TWINT 30.00 to Bakery')).toBeGreaterThanOrEqual(0.5);
  });
});

describe('compactText', () => {
  it('drops address segments and keeps the payee and purpose', () => {
    const raw = 'Credit payment to landlord ⏐ Alpenblick Rental AG ⏐ Bahnhofstrasse 12 ⏐ 8001 Zurich ⏐ Payment purpose: Rent March 2026';
    const out = compactText(raw);
    expect(out).toContain('Alpenblick Rental AG');
    expect(out).toContain('Rent March 2026');
    expect(out).not.toContain('8001 Zurich');
    expect(out).not.toContain('Bahnhofstrasse 12');
  });
  it('caps the length', () => {
    expect(compactText('x'.repeat(400)).length).toBeLessThanOrEqual(140);
  });
});

describe('simplifyTxs', () => {
  it('passes small lists through unchanged — one line per row', () => {
    const lines = simplifyTxs(many(120));
    expect(lines).toHaveLength(120);
    expect(lines.every((l) => l.count === 1)).toBe(true);
  });

  it('merges rows with the same IBAN and 50% identical text into one line', () => {
    const lines = simplifyTxs(many(400));
    expect(lines.length).toBeLessThanOrEqual(AI_LINE_LIMIT);
    expect(lines).toHaveLength(1); // same account, same payee wording
    expect(lines[0].count).toBe(400);
    expect(lines[0].debit).toBeCloseTo(400 * 24.5, 6);
  });

  it('keeps distinct payees of the same account as separate lines', () => {
    const mixed: Tx[] = [];
    const payees = ['MIGROS ZURICH', 'COOP Winterthur', 'SBB CFF FFS ticket', 'Netflix premium monthly'];
    for (let i = 0; i < 200; i++) {
      const p = payees[i % payees.length];
      mixed.push(tx({ ref: `R${i}`, text: `Debit card purchase ${p}`, hay: `Debit card purchase ${p}` }));
    }
    const lines = simplifyTxs(mixed);
    expect(lines.length).toBeLessThanOrEqual(AI_LINE_LIMIT);
    expect(lines.length).toBe(payees.length);
    expect(lines.reduce((s, l) => s + l.count, 0)).toBe(200);
  });

  it('splits lines by IBAN and caps the result at the limit', () => {
    const rows: Tx[] = [];
    for (let i = 0; i < 300; i++) {
      rows.push(tx({ iban: `CH450470000000${String(i % 400).padStart(6, '0')}`, ref: `R${i}`, text: `Payee number ${i} unique shop` }));
    }
    const lines = simplifyTxs(rows);
    expect(lines.length).toBe(AI_LINE_LIMIT);
  });

  it('renders lines with count, signed total, IBAN and text', () => {
    const out = renderLines(simplifyTxs([tx({ credit: 100, debit: 0 })]));
    expect(out).toContain('+100.00');
    expect(out).toContain('CH45 0470 0000 0012 3456');
    expect(out).toContain('MIGROS');
  });
});

describe('buildAiPrompt', () => {
  const settings = parseSettings(JSON.stringify({ name: 'x', categories: [{ tag: 'Housing' }, { tag: 'Rent', tag_father: 'Housing', search_tag: ['miete'] }] }), 'x');

  it('describes the JSON format and the matching rules', () => {
    const p = buildAiPrompt(emptySettings('x'), null);
    expect(p).toContain('"categories"');
    expect(p).toContain('tag_father');
    expect(p).toContain('search_tag');
    expect(p).toContain('FIRST');
    expect(p).toContain('Return ONLY the JSON');
    expect(p).toContain('do not add it'); // Uncategorized is the app's own fallback
  });

  it('leaves the transactions block out when no data is included', () => {
    const p = buildAiPrompt(emptySettings('x'), null);
    expect(p).not.toContain('My transactions');
    expect(p).toContain('Return only the JSON');
  });

  it('carries the transactions when lines are given', () => {
    const p = buildAiPrompt(emptySettings('x'), simplifyTxs(many(10)));
    expect(p).toContain('MIGROS ZURICH');
    expect(p).toContain('10 lines');
  });

  it('shows the current categories so the AI extends them', () => {
    const p = buildAiPrompt(settings, null);
    expect(p).toContain('My current categories');
    expect(p).toContain('  - Rent: miete');
  });
});
