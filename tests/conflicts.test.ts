import { describe, expect, it } from 'vitest';
import type { Tx } from '../src/types';
import { auditSettings, decide, explainTx, hiddenRows, isDead, undecidedRows } from '../src/categories/conflicts';
import { aggregate, matchTx, UNCAT } from '../src/categories/engine';
import { parseSettings } from '../src/categories/schema';
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

const IBAN1 = normalizeIban('CH89 0839 0039 7668 1000 2');
const IBAN2 = normalizeIban('CH89 0839 0039 7668 1010 0');

/** settings JSON → parsed bundle */
const s = (categories: unknown[]) => parseSettings(JSON.stringify({ categories }), 't');

describe('auditSettings — rows lost to a higher priority', () => {
  const settings = s([
    { tag: 'Rent', iban: [], search_tag: ['miete'] },
    { tag: 'Energy', iban: [], search_tag: ['miete'] },
    { tag: 'Other', iban: [], search_tag: ['strom'] },
  ]);
  const report = auditSettings(settings, [tx({ hay: 'Miete Oktober' }), tx({ hay: 'SH POWER Strom' })]);

  it('counts every category whose own rules match, not just the winner', () => {
    expect(report.audits.map((a) => [a.tag, a.wouldMatch, a.won])).toEqual([
      ['Rent', 1, 1],
      ['Energy', 1, 0],
      ['Other', 1, 1],
    ]);
  });

  it('names the category that took the rows', () => {
    expect(report.audits[1].shadowedBy).toEqual([{ catIndex: 0, tag: 'Rent', count: 1 }]);
    expect(hiddenRows(report.audits[1])).toBe(1);
    expect(isDead(report.audits[1])).toBe(true); // it would match, but never wins
    expect(isDead(report.audits[0])).toBe(false);
  });

  it('leaves a category that simply does not match alone', () => {
    expect(report.audits[2].shadowedBy).toEqual([]);
    expect(hiddenRows(report.audits[2])).toBe(0);
  });

  it('a parent with its own rules beats its children (the seeded "Income" case)', () => {
    const settings = s([
      { tag: 'Income', iban: [], search_tag: ['lohn'] },
      { tag: 'Benefits', tag_father: 'Income', iban: [], search_tag: ['kindergeld'] },
    ]);
    expect(matchTx(tx({ hay: 'Lohn inkl. Kindergeld' }), settings)).toBe('Income');
    const a = auditSettings(settings, [tx({ hay: 'Lohn inkl. Kindergeld' }), tx({ hay: 'Kindergeld' })]);
    expect(a.audits[0].won).toBe(1);
    expect(a.audits[1].wouldMatch).toBe(2); // both rows carry "kindergeld"
    expect(a.audits[1].won).toBe(1);
    expect(hiddenRows(a.audits[1])).toBe(1);
    expect(isDead(a.audits[1])).toBe(false);
  });

  it('an IBAN-only parent swallows every row of that account', () => {
    const settings = s([
      { tag: 'Account', iban: [IBAN1], search_tag: [] },
      { tag: 'Rent', tag_father: 'Account', iban: [], search_tag: ['miete'] },
    ]);
    expect(matchTx(tx({ iban: IBAN1, hay: 'Miete 1200' }), settings)).toBe('Account');
    const a = auditSettings(settings, [tx({ iban: IBAN1, hay: 'Miete 1200' }), tx({ iban: IBAN2, hay: 'Miete 1200' })]);
    expect(a.audits[0].wouldMatch).toBe(1); // the parent covers the IBAN1 row only
    expect(a.audits[0].won).toBe(1);
    // and the child — which has no IBAN of its own and so applies to both
    // accounts — loses that row without any hint in a count-only editor
    expect(a.audits[1].wouldMatch).toBe(2);
    expect(a.audits[1].won).toBe(1);
    expect(hiddenRows(a.audits[1])).toBe(1);
    expect(a.audits[1].shadowedBy).toEqual([{ catIndex: 0, tag: 'Account', count: 1 }]);
  });

  it('two sub-categories of one parent: the row is counted exactly once', () => {
    const settings2 = s([
      { tag: 'Housing', iban: [], search_tag: [] },
      { tag: 'Rent', tag_father: 'Housing', iban: [], search_tag: ['miete'] },
      { tag: 'Flat sharing', tag_father: 'Housing', iban: [], search_tag: ['miete'] },
    ]);
    const a = auditSettings(settings2, [tx({ hay: 'Miete WG' })]);
    expect(a.audits.map((x) => x.won)).toEqual([0, 1, 0]);
    expect(hiddenRows(a.audits[2])).toBe(1);
    // the parent total is the same whichever child wins, so only the split moves
    const agg = aggregate([tx({ hay: 'Miete WG', debit: 100 })], settings2);
    expect(agg.subtree.get('Housing')).toEqual({ debit: 100, credit: 0, count: 1 });
  });

  it('a disabled category neither wins nor shadows', () => {
    const a = auditSettings(
      s([
        { tag: 'Off', enabled: false, iban: [], search_tag: ['miete'] },
        { tag: 'Rent', iban: [], search_tag: ['miete'] },
      ]),
      [tx({ hay: 'Miete' })],
    );
    expect(a.audits.map((x) => [x.wouldMatch, x.won])).toEqual([[0, 0], [1, 1]]);
  });

  it('a category without rules and without IBANs matches nothing', () => {
    const a = auditSettings(s([{ tag: 'Group', iban: [], search_tag: [] }]), [tx({ hay: 'Miete' })]);
    expect(a.audits[0].wouldMatch).toBe(0);
    expect(a.audits[0].shadowedBy).toEqual([]);
  });
});

describe('auditSettings — preview', () => {
  const settings = s([
    { tag: 'Rent', iban: [], search_tag: ['miete'] },
    { tag: 'Energy', iban: [], search_tag: ['miete'] },
  ]);
  const rows = [tx({ hay: 'Miete', debit: 1200 }), tx({ hay: 'Strom', credit: 0, debit: 90 }), tx({ hay: 'Lohn' })];

  it('holds the winning assignment per tag, Uncategorized included', () => {
    const a = auditSettings(settings, rows);
    expect(a.preview.get('Rent')).toEqual({ count: 1, debit: 1200, credit: 0 });
    expect(a.preview.get(UNCAT)).toEqual({ count: 2, debit: 90, credit: 0 });
    expect(a.preview.has('Energy')).toBe(false);
  });

  it('agrees with matchTx for every row (it replaces computePreview)', () => {
    const a = auditSettings(settings, rows);
    const byTag = new Map<string, number>();
    for (const t of rows) byTag.set(matchTx(t, settings), (byTag.get(matchTx(t, settings)) ?? 0) + 1);
    for (const [tag, count] of byTag) expect(a.preview.get(tag)?.count).toBe(count);
  });

  it('merges categories that share a tag', () => {
    const a = auditSettings(
      s([
        { tag: 'Dup', iban: [], search_tag: ['miete'] },
        { tag: 'Dup', iban: [], search_tag: ['strom'] },
      ]),
      rows,
    );
    expect(a.audits.map((x) => x.won)).toEqual([1, 1]);
    expect(a.preview.get('Dup')?.count).toBe(2);
  });

  it('is empty without transactions while the audits stay at zero', () => {
    const a = auditSettings(settings, []);
    expect(a.preview.size).toBe(0);
    expect(a.audits.every((x) => x.wouldMatch === 0 && x.won === 0)).toBe(true);
  });
});

describe('static duplicate checks', () => {
  it('flags an identical rule that is already decided higher up', () => {
    const a = auditSettings(s([
      { tag: 'Rent', iban: [], search_tag: ['miete'] },
      { tag: 'Energy', iban: [], search_tag: ['miete'] },
    ]), []);
    expect(a.ruleOwner).toEqual([[-1], [0]]);
  });

  it('does not flag a lower category against a higher one, only the copy', () => {
    const a = auditSettings(s([
      { tag: 'Rent', iban: [], search_tag: ['miete', 'mietzins'] },
      { tag: 'Energy', iban: [], search_tag: ['miete'] },
    ]), []);
    expect(a.ruleOwner[0]).toEqual([-1, -1]);
    expect(a.ruleOwner[1]).toEqual([0]);
  });

  it('same text with different flags is a different rule', () => {
    const a = auditSettings(s([
      { tag: 'Rent', iban: [], search_tag: ['miete'] },
      { tag: 'Exact', iban: [], search_tag: ['case_sensitive', 'miete'] },
      { tag: 'Pattern', iban: [], search_tag: [{ text: 'miete', regex: true }] },
    ]), []);
    expect(a.ruleOwner).toEqual([[-1], [-1], [-1]]);
  });

  it('treats case-only differences as the same rule when both match case-insensitively', () => {
    const a = auditSettings(s([
      { tag: 'Online Shopping', iban: [], search_tag: ['paypal'] },
      { tag: 'Marketplace', iban: [], search_tag: ['PayPal'] },
    ]), []);
    expect(a.ruleOwner).toEqual([[-1], [0]]);
  });

  it('keeps a case-sensitive rule distinct from its case-insensitive twin', () => {
    const a = auditSettings(s([
      { tag: 'Online Shopping', iban: [], search_tag: ['paypal'] },
      { tag: 'Exact', iban: [], search_tag: ['case_sensitive', 'paypal'] },
    ]), []);
    expect(a.ruleOwner).toEqual([[-1], [-1]]);
  });

  it('flags a repeat inside one category (one matching tag is enough)', () => {
    const a = auditSettings(s([{ tag: 'Rent', iban: [], search_tag: ['miete', 'miete'] }]), []);
    expect(a.ruleOwner).toEqual([[-1, 0]]);
  });

  it('reports a tag used by more than one category', () => {
    const a = auditSettings(s([
      { tag: 'Dup', iban: [], search_tag: ['a'] },
      { tag: 'Other', iban: [], search_tag: ['b'] },
      { tag: 'Dup', tag_father: 'Other', iban: [], search_tag: ['c'] },
    ]), []);
    expect(a.duplicateTags).toEqual([{ tag: 'Dup', indexes: [0, 2] }]);
  });

  it('reports the empty search text that matches every transaction', () => {
    const settings = s([
      { tag: 'Rent', iban: [], search_tag: [''] },
      { tag: 'Other', iban: [], search_tag: ['b'] },
    ]);
    const a = auditSettings(settings, [tx({ hay: 'anything' })]);
    expect(a.matchAll).toEqual([0]);
    expect(a.audits[0].wouldMatch).toBe(1);
    expect(a.audits[1].won).toBe(0);
    expect(matchTx(tx({ hay: 'anything' }), settings)).toBe('Rent');
  });
});

describe('decide + explainTx — one row down to the rule', () => {
  const two = s([
    { tag: 'Rent', iban: [], search_tag: ['miete'] },
    { tag: 'Energy', iban: [], search_tag: ['miete', 'strom'] },
  ]);

  it('agrees with matchTx on who wins', () => {
    for (const row of [tx({ hay: 'Miete' }), tx({ hay: 'Strom' }), tx({ hay: 'nichts' })]) {
      const d = decide(two, row);
      expect(d ? two.categories[d.catIndex].tag : UNCAT).toBe(matchTx(row, two));
    }
  });

  it('lists every claimant in priority order and names the decided rule', () => {
    const row = tx({ hay: 'Miete und Strom' });
    expect(explainTx(two, row)).toEqual([
      { catIndex: 0, tag: 'Rent', wins: true, rules: [0] },
      { catIndex: 1, tag: 'Energy', wins: false, rules: [0, 1] },
    ]);
    expect(decide(two, row)).toEqual({ catIndex: 0, ruleIndex: 0 });
  });

  it('says which category matched on its IBAN list alone (no rule)', () => {
    const settings = s([
      { tag: 'Account', iban: [IBAN1], search_tag: [] },
      { tag: 'Rent', tag_father: 'Account', iban: [], search_tag: ['miete'] },
    ]);
    const row = tx({ iban: IBAN1, hay: 'Miete 1200' });
    expect(decide(settings, row)).toEqual({ catIndex: 0, ruleIndex: -1 });
    expect(explainTx(settings, row)[0].rules).toEqual([]);
  });

  it('returns nothing for an unmatched row', () => {
    expect(decide(two, tx({ hay: 'nichts' }))).toBeNull();
    expect(explainTx(two, tx({ hay: 'nichts' }))).toEqual([]);
  });
});

describe('undecidedRows — the transactions behind a conflict', () => {
  const rows = [tx({ hay: 'Miete Oktober' }), tx({ hay: 'Miete und Strom' }), tx({ hay: 'Zinse' })];

  it('category view: the rows it matches but a higher priority one takes', () => {
    const settings = s([
      { tag: 'Rent', iban: [], search_tag: ['miete'] },
      { tag: 'Energy', iban: [], search_tag: ['miete'] },
    ]);
    expect(undecidedRows(settings, rows, 1, null).map((t) => t.hay)).toEqual(['Miete Oktober', 'Miete und Strom']);
    expect(undecidedRows(settings, rows, 0, null)).toEqual([]); // it decides them itself
  });

  it('rule view: a copy of a rule higher up lists the rows it cannot decide', () => {
    const settings = s([
      { tag: 'Rent', iban: [], search_tag: ['miete'] },
      { tag: 'Energy', iban: [], search_tag: ['miete', 'strom'] },
    ]);
    expect(undecidedRows(settings, rows, 1, 0).map((t) => t.hay)).toEqual(['Miete Oktober', 'Miete und Strom']);
    // 'strom' is Energy's own rule, yet Rent is listed first and already took the row
    expect(undecidedRows(settings, rows, 1, 1).map((t) => t.hay)).toEqual(['Miete und Strom']);
  });

  it('rule view inside one category: the line another of its own rules already covers', () => {
    const settings = s([{ tag: 'Rent', iban: [], search_tag: ['miete', 'miete oktober'] }]);
    // the category wins both rows, but rule 2 decides nothing: rule 1 hits first
    expect(undecidedRows(settings, rows, 0, 1).map((t) => t.hay)).toEqual(['Miete Oktober']);
    expect(undecidedRows(settings, rows, 0, 0)).toEqual([]);
    expect(undecidedRows(settings, rows, 0, null)).toEqual([]);
  });

  it('is empty for an unknown category or rule', () => {
    const settings = s([{ tag: 'Rent', iban: [], search_tag: ['miete'] }]);
    expect(undecidedRows(settings, rows, 5, null)).toEqual([]);
    expect(undecidedRows(settings, rows, 0, 3)).toEqual([]);
  });

  it('the takers the audit counts are the rows the panel lists', () => {
    const settings = s([
      { tag: 'Rent', iban: [], search_tag: ['miete'] },
      { tag: 'Energy', iban: [], search_tag: ['miete'] },
    ]);
    const a = auditSettings(settings, rows);
    expect(hiddenRows(a.audits[1])).toBe(undecidedRows(settings, rows, 1, null).length);
    expect(a.audits[1].shadowedBy[0]).toEqual({ catIndex: 0, tag: 'Rent', count: 2 });
  });
});
