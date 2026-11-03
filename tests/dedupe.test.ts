import { describe, expect, it } from 'vitest';
import { parseWithMapper } from '../src/csv/parse';
import { ABS_MAPPER } from '../src/csv/schemas';
import { dedupIngest, mergeInto } from '../src/csv/dedupe';
import type { Tx } from '../src/types';

const IBAN = 'CH89 0839 0039 7668 1000 2';

function csv(rows: string[]): string {
  return [
    'Buchungsdatum,Valutadatum,Auftragsnummer,Konto,Kontoalias,IBAN,Buchungstext,Gutschrift,Belastung',
    ...rows,
  ].join('\n') + '\n';
}

function parse(rows: string[], name = 'a.csv'): Tx[] {
  return parseWithMapper(csv(rows), name, ABS_MAPPER).txs;
}

function ingestAll(files: Tx[][]): Map<string, Tx> {
  const byId = new Map<string, Tx>();
  for (const txs of files) dedupIngest(txs, byId);
  return byId;
}

describe('dedup across overlapping exports', () => {
  it('same tx id + IBAN + amount with different text → one tx, longer text wins', () => {
    const a = parse(['01.10.2026,01.10.2026,X1,K,A,' + IBAN + ',SHORT,,50.00']);
    const b = parse(['01.10.2026,01.10.2026,X1,K,A,' + IBAN + ',LONGER FULL DESCRIPTION,,50.00'], 'b.csv');
    expect(a[0]!.id).toBe(b[0]!.id);
    const merged = ingestAll([a, b]);
    expect(merged.size).toBe(1);
    expect([...merged.values()][0]!.text).toBe('LONGER FULL DESCRIPTION');
  });

  it('different amount with the same tx id → treated as separate transactions', () => {
    const a = parse(['01.10.2026,01.10.2026,X1,K,A,' + IBAN + ',rent,,50.00']);
    const b = parse(['01.10.2026,01.10.2026,X1,K,A,' + IBAN + ',rent,,60.00'], 'b.csv');
    expect(a[0]!.id).not.toBe(b[0]!.id);
    expect(ingestAll([a, b]).size).toBe(2);
  });

  it('same id + amount but newer booking date → newer date wins', () => {
    const a = parse(['01.10.2026,01.10.2026,X1,K,A,' + IBAN + ',word,,50.00']);
    const b = parse(['04.10.2026,08.10.2026,X1,K,A,' + IBAN + ',word,,50.00'], 'b.csv');
    const merged = ingestAll([a, b]);
    expect(merged.size).toBe(1);
    const t = [...merged.values()][0]!;
    expect(t.bookingDate).toBe('2026-10-04');
    expect(t.valueDate).toBe('2026-10-08');
  });

  it('longer text and newer date merge independently of source file order', () => {
    const short_old = parse(['01.10.2026,01.10.2026,X1,K,A,' + IBAN + ',ab,,50.00']);
    const long_newer = parse(['09.10.2026,01.10.2026,X1,K,A,' + IBAN + ',abcdefghij,,50.00'], 'b.csv');
    const m1 = ingestAll([short_old, long_newer]);
    const t1 = [...m1.values()][0]!;
    expect(t1.text).toBe('abcdefghij');
    expect(t1.bookingDate).toBe('2026-10-09');
    // same result when the newer file is ingested first
    const m2 = ingestAll([long_newer, short_old]);
    const t2 = [...m2.values()][0]!;
    expect(t2.text).toBe('abcdefghij');
    expect(t2.bookingDate).toBe('2026-10-09');
  });

  it('internal transfer legs (same ref, one credit + one debit) stay separate', () => {
    const a = parse(['13.08.2026,13.08.2026,ZV1,K,A,' + IBAN + ',transfer,,500.00']);
    const b = parse(['13.08.2026,13.08.2026,ZV1,K,A,CH6208390039766810100,transfer,500.00,']);
    expect(a[0]!.id).not.toBe(b[0]!.id);
    expect(ingestAll([a, b]).size).toBe(2);
  });

  it('rows without a transaction id dedup only on exact content', () => {
    const a = parse(['01.10.2026,01.10.2026,,K,A,' + IBAN + ',cash,,20.00']);
    const b = parse(['01.10.2026,01.10.2026,,K,A,' + IBAN + ',cash,,20.00'], 'b.csv');
    const c = parse(['02.10.2026,02.10.2026,,K,A,' + IBAN + ',cash,,20.00'], 'c.csv');
    expect(a[0]!.id).toBe(b[0]!.id);
    expect(a[0]!.id).not.toBe(c[0]!.id);
    expect(ingestAll([a, b, c]).size).toBe(2);
  });
});

describe('mergeInto', () => {
  function tx(p: Partial<Tx>): Tx {
    return {
      id: 'x', file: 'f', row: 1, bookingDate: '', valueDate: '', ref: '', account: '', accountAlias: '',
      iban: '', ibanDisplay: '', text: '', hay: '', credit: 0, debit: 0, ...p,
    };
  }

  it('applies text and date rules independently', () => {
    const cur = tx({ text: 'medium text', hay: 'medium text', bookingDate: '2026-05-01', valueDate: '2026-05-02' });
    mergeInto(cur, tx({ text: 'tiny', hay: 'tiny', bookingDate: '2026-06-01', valueDate: '2026-04-01' }));
    expect(cur.text).toBe('medium text'); // longer stays
    expect(cur.bookingDate).toBe('2026-06-01'); // newer wins
    expect(cur.valueDate).toBe('2026-05-02'); // older incoming ignored
  });
});
