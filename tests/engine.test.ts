import { describe, expect, it } from 'vitest';
import type { Tx } from '../src/types';
import { aggregate, buildTree, fuzzyIn, matchTx, UNCAT } from '../src/categories/engine';
import { parseSettings, serializeSettings } from '../src/categories/schema';
import { normalizeIban } from '../src/csv/parse';

function tx(partial: Partial<Tx>): Tx {
  return {
    id: Math.random().toString(36),
    file: 'f.csv',
    row: 1,
    bookingDate: '2026-10-05',
    valueDate: '2026-10-05',
    ref: 'R1',
    account: 'A',
    accountAlias: 'A',
    iban: IBAN1,
    ibanDisplay: 'CH89 0839 0039 7668 1000 2',
    text: '',
    hay: '',
    credit: 0,
    debit: 0,
    ...partial,
  };
}

const SKETCH = {
  categories: [
    { tag: 'Wohnen', iban: [], search_tag: [] },
    { tag: 'Miete', tag_father: 'Wohnen', iban: [], search_tag: ['case_insensitive', 'miete'] },
    { tag: 'Strom', tag_father: 'Wohnen', iban: [], search_tag: ['SH POWER'] },
    { tag: 'Exact', iban: [], search_tag: ['case_sensitive', 'ACME'] },
    { tag: 'Fuzzy', iban: [], search_tag: ['fuzzy', 'mls'] },
    { tag: 'Rx', iban: [], search_tag: [{ text: '^Einkauf', regex: true }] },
    { tag: 'JanOnly', iban: [], search_tag: ['needjan'], date_from: '2026-01-01', date_to: '2026-01-31' },
    { tag: 'Account2', iban: ['CH89 0839 0039 7668 1010 0'], search_tag: [] },
    { tag: 'Empty', iban: [], search_tag: [] },
  ],
};

const settings = parseSettings(JSON.stringify(SKETCH), 't');
const IBAN1 = normalizeIban('CH89 0839 0039 7668 1000 2');
const IBAN2 = normalizeIban('CH89 0839 0039 7668 1010 0');
describe('parseSettings (sketch format)', () => {
  it('handles flag tokens and typed entries', () => {
    const byTag = new Map(settings.categories.map((c) => [c.tag, c]));
    expect(byTag.get('Miete')!.rules).toEqual([{ text: 'miete', caseSensitive: false, fuzzy: false, regex: false }]);
    expect(byTag.get('Exact')!.rules[0].caseSensitive).toBe(true);
    expect(byTag.get('Fuzzy')!.rules[0].fuzzy).toBe(true);
    expect(byTag.get('Rx')!.rules[0].regex).toBe(true);
    expect(byTag.get('Account2')!.ibans).toEqual([IBAN2]);
    expect(byTag.get('JanOnly')!.dateFrom).toBe('2026-01-01');
  });

  it('tolerates the case_insentive typo from the spec', () => {
    const s = parseSettings(JSON.stringify({ categories: [{ tag: 'x', search_tag: ['case_insentive', 'y'] }] }), 't');
    expect(s.categories[0].rules[0].caseSensitive).toBe(false);
  });

  it('round-trips through serializeSettings', () => {
    const text = serializeSettings(settings);
    const again = parseSettings(text, 't');
    expect(again.categories.map((c) => c.rules)).toEqual(settings.categories.map((c) => c.rules));
    expect(again.categories.map((c) => c.tagFather)).toEqual(settings.categories.map((c) => c.tagFather));
  });

  it('preserves literal rules whose text is a mode flag', () => {
    const texts = ['plain', 'fuzzy', 'regex', 'contains', 'case_sensitive', 'case insensitive', 'case_insentive'];
    const original = parseSettings(JSON.stringify({ categories: [{
      tag: 'Literal', search_tag: texts.map((text) => ({ text })),
    }] }), 't');
    expect(parseSettings(serializeSettings(original), 't')).toEqual(original);
  });
});

describe('matching', () => {
  it('case-insensitive substring', () => {
    expect(matchTx(tx({ hay: 'Zahlungszweck: Miete Oktober 2026' }), settings)).toBe('Miete');
  });
  it('first match wins (priority order)', () => {
    expect(matchTx(tx({ hay: 'miete SH POWER' }), settings)).toBe('Miete');
  });
  it('case-sensitive rule', () => {
    expect(matchTx(tx({ hay: 'acme corp' }), settings)).toBe(UNCAT);
    expect(matchTx(tx({ hay: 'ACME corp' }), settings)).toBe('Exact');
  });
  it('fuzzy rule', () => {
    expect(fuzzyIn('sammlerstrasse', 'mls')).toBe(true);
    expect(matchTx(tx({ hay: 'Sammlerstrasse 4' }), settings)).toBe('Fuzzy');
    expect(matchTx(tx({ hay: 'msl nope' }), settings)).toBe(UNCAT);
  });
  it('regex rule', () => {
    expect(matchTx(tx({ hay: 'Einkauf Debitkarte 28.09 Migros' }), settings)).toBe('Rx');
    expect(matchTx(tx({ hay: 'heute Einkauf' }), settings)).toBe(UNCAT);
  });
  it('invalid regex never matches', () => {
    const s = parseSettings(JSON.stringify({ categories: [{ tag: 'bad', search_tag: [{ text: '(', regex: true }] }] }), 't');
    expect(matchTx(tx({ hay: 'anything (' }), s)).toBe(UNCAT);
  });
  it('category date range restricts matching', () => {
    expect(matchTx(tx({ hay: 'NEEDJAN', bookingDate: '2026-01-15' }), settings)).toBe('JanOnly');
    expect(matchTx(tx({ hay: 'NEEDJAN', bookingDate: '2026-02-15' }), settings)).toBe(UNCAT);
  });
  it('iban-only category matches all transactions of that account', () => {
    expect(matchTx(tx({ iban: IBAN2, hay: 'whatever' }), settings)).toBe('Account2');
    expect(matchTx(tx({ iban: IBAN1, hay: 'whatever' }), settings)).toBe(UNCAT);
  });
  it('empty category matches nothing', () => {
    expect(matchTx(tx({ hay: 'anything at all' }), settings)).toBe(UNCAT);
  });
  it('disabled category is skipped', () => {
    const s = parseSettings(JSON.stringify({ categories: [{ tag: 'x', enabled: false, search_tag: ['einkauf'] }] }), 't');
    expect(matchTx(tx({ hay: 'Einkauf' }), s)).toBe(UNCAT);
  });
});

describe('tree + aggregation', () => {
  it('builds parent/child structure with Uncategorized root', () => {
    const roots = buildTree(settings);
    const wohnen = roots.find((r) => r.tag === 'Wohnen');
    expect(wohnen!.children.map((c) => c.tag).sort()).toEqual(['Miete', 'Strom']);
    expect(roots.some((r) => r.tag === UNCAT)).toBe(true);
  });

  it('rolls children totals into parents', () => {
    const txs = [
      tx({ hay: 'Miete Oktober', debit: 1600, bookingDate: '2026-10-01' }),
      tx({ hay: 'SH POWER rate', debit: 500, bookingDate: '2026-10-01' }),
      tx({ hay: 'Migros', debit: 40, bookingDate: '2026-09-01' }),
    ];
    const agg = aggregate(txs, settings);
    const wohnen = agg.subtree.get('Wohnen')!;
    expect(wohnen.debit).toBe(2100);
    expect(agg.subtree.get('Miete')!.debit).toBe(1600);
    expect(agg.subtree.get(UNCAT)!.debit).toBe(40);
    expect(agg.months).toEqual(['2026-09', '2026-10']);
    const oct = agg.subtree.get('Wohnen')!;
    expect(oct.count).toBe(2);
    expect(agg.own.get('Miete')!.get('2026-10')!.debit).toBe(1600);
  });

  it('handles parent cycles without infinite loop', () => {
    const s = parseSettings(
      JSON.stringify({ categories: [{ tag: 'A', tag_father: 'B', search_tag: ['x'] }, { tag: 'B', tag_father: 'A', search_tag: ['x'] }] }),
      't',
    );
    const roots = buildTree(s);
    expect(roots.length).toBeGreaterThan(0);
  });
});
