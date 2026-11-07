import { describe, expect, it, beforeEach } from 'vitest';
import type { Mapper } from '../src/types';
import { ingestFiles } from '../src/csv/dedupe';
import { ABS_MAPPER, detectBestMapper } from '../src/csv/schemas';
import { allMappers, deleteMapper, isBuiltin, listSaved, renameMapper, saveMapper } from '../src/storage/mappers';

// storage/mappers only touches localStorage inside calls → a stub is enough for node tests
function makeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  } as unknown as Storage;
}
beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = makeStorage();
});

const IBAN = 'CH8908390039766810002';

const CUSTOM: Mapper = {
  name: 'Test Bank',
  columns: { bookingDate: 'Date', text: 'Description', amount: 'Amount', txId: 'Ref', iban: 'IBAN' },
};

const absCsv = (rows: string[]): string =>
  [
    'Buchungsdatum,Valutadatum,Auftragsnummer,Konto,Kontoalias,IBAN,Buchungstext,Gutschrift,Belastung',
    ...rows,
  ].join('\n') + '\n';

const customCsv = (rows: string[]): string =>
  ['Date,Description,Amount,Ref,IBAN', ...rows].join('\n') + '\n';

describe('ingestFiles (per-file mapper snapshots)', () => {
  it.each(['Ref', ''])('scopes non-IBAN dedup keys by account with txId=%s', (txId) => {
    const mapper: Mapper = { name: 'Accounts', columns: {
      bookingDate: 'Date', text: 'Description', amount: 'Amount', account: 'Account', ...(txId ? { txId } : {}),
    } };
    const content = 'Date,Description,Amount,Account,Ref\n2026-01-01,Coffee,-5,Checking,R1\n2026-01-01,Coffee,-5,Savings,R1';
    const result = ingestFiles([
      { name: 'a.csv', content, mapper },
      { name: 'overlap.csv', content, mapper },
    ]);
    expect(result.txs).toHaveLength(2);
    expect(result.txs.map((t) => t.account).sort()).toEqual(['Checking', 'Savings']);
  });

  it('uses aliases when neither IBAN nor account is mapped', () => {
    const mapper: Mapper = { name: 'Aliases', columns: {
      bookingDate: 'Date', text: 'Description', amount: 'Amount', accountAlias: 'Alias',
    } };
    const content = 'Date,Description,Amount,Alias\n2026-01-01,Coffee,-5,Checking\n2026-01-01,Coffee,-5,Savings';
    expect(ingestFiles([{ name: 'a.csv', content, mapper }]).txs).toHaveLength(2);
  });
  it('parses each file with its own mapper and merges across banks', () => {
    const res = ingestFiles([
      { name: 'abs.csv', content: absCsv(['01.10.2026,01.10.2026,A1,K,KU,' + IBAN + ',ABS rent,,500.00']), mapper: ABS_MAPPER },
      { name: 'other.csv', content: customCsv(['2026-10-02,Salary,1200,B1,' + IBAN]), mapper: CUSTOM },
    ]);
    expect(res.txs).toHaveLength(2);
    expect(res.needsMapper).toEqual([]);
    expect(res.files.map((f) => [f.name, f.rows, f.mapper])).toEqual([
      ['abs.csv', 1, ABS_MAPPER.name],
      ['other.csv', 1, CUSTOM.name],
    ]);
    const byRef = new Map(res.txs.map((t) => [t.ref, t]));
    expect(byRef.get('A1')!.debit).toBe(500);
    expect(byRef.get('B1')!.credit).toBe(1200);
  });

  it('dedups overlapping exports the same way regardless of which file order', () => {
    const a = absCsv(['01.10.2026,01.10.2026,A1,K,KU,' + IBAN + ',short text,,50.00']);
    const b = absCsv(['04.10.2026,08.10.2026,A1,K,KU,' + IBAN + ',longer full text,,50.00']);
    const inputs = [
      { name: 'a.csv', content: a, mapper: ABS_MAPPER },
      { name: 'b.csv', content: b, mapper: ABS_MAPPER },
    ];
    const one = ingestFiles(inputs);
    const other = ingestFiles([...inputs].reverse());
    expect(one.txs).toHaveLength(1);
    expect(one.txs[0].text).toBe('longer full text');
    expect(one.txs[0].bookingDate).toBe('2026-10-04');
    expect(other.txs).toHaveLength(1);
    expect(other.txs[0].text).toBe(one.txs[0].text);
    expect(other.txs[0].bookingDate).toBe(one.txs[0].bookingDate);
  });

  it('null mapper → file needs remapping, contributes nothing', () => {
    const res = ingestFiles([{ name: 'x.csv', content: absCsv(['01.10.2026,01.10.2026,A1,K,KU,' + IBAN + ',t,,5.00']), mapper: null }]);
    expect(res.needsMapper).toEqual(['x.csv']);
    expect(res.txs).toHaveLength(0);
    expect(res.files[0]).toEqual({ name: 'x.csv', rows: 0, mapper: '' });
  });

  it('stale snapshot whose columns are gone → needs remapping, contributes nothing', () => {
    const res = ingestFiles([
      { name: 'old-format.csv', content: customCsv(['2026-10-02,Salary,1200,B1,' + IBAN]), mapper: ABS_MAPPER },
      { name: 'good.csv', content: customCsv(['2026-10-03,Food,20.00,B2,' + IBAN]), mapper: CUSTOM },
    ]);
    expect(res.needsMapper).toEqual(['old-format.csv']);
    expect(res.txs).toHaveLength(1);
    expect(res.files[0].mapper).toBe(ABS_MAPPER.name); // name kept so the UI shows what was tried
    expect(res.files[0].rows).toBe(0);
  });
});

describe('detectBestMapper', () => {
  it('prefers the earlier candidate at equal coverage (registry order = built-ins first)', () => {
    const headers = ['Buchungsdatum', 'Valutadatum', 'Auftragsnummer', 'Konto', 'Kontoalias', 'IBAN', 'Buchungstext', 'Gutschrift', 'Belastung'];
    const sparse: Mapper = { name: 'Sparse', columns: { bookingDate: 'Buchungsdatum', text: 'Buchungstext', debit: 'Belastung' } };
    expect(detectBestMapper(headers, [ABS_MAPPER, sparse])!.mapper.name).toBe(ABS_MAPPER.name);
    expect(detectBestMapper(headers, [sparse, ABS_MAPPER])!.score).toBe(1);
  });

  it('only candidates with all required columns can win', () => {
    const headers = ['Date', 'Description', 'Amount', 'Ref', 'IBAN'];
    const best = detectBestMapper(headers, [ABS_MAPPER, CUSTOM]);
    expect(best!.mapper.name).toBe(CUSTOM.name);
    expect(best!.score).toBe(1);
    const none = detectBestMapper(headers, [ABS_MAPPER]);
    expect(none).toBeNull();
  });
});

describe('mapper registry (banking.mappers)', () => {
  it('offers built-ins first and keeps saved ones separate', () => {
    expect(allMappers().map((m) => m.name)).toEqual([ABS_MAPPER.name]);
    saveMapper(CUSTOM);
    expect(listSaved().map((m) => m.name)).toEqual([CUSTOM.name]);
    expect(allMappers().map((m) => m.name)).toEqual([ABS_MAPPER.name, CUSTOM.name]);
  });

  it('protects built-in schemas', () => {
    expect(isBuiltin(ABS_MAPPER.name)).toBe(true);
    expect(() => saveMapper({ ...ABS_MAPPER, columns: { ...ABS_MAPPER.columns } })).toThrow(/built-in/);
    expect(() => deleteMapper(ABS_MAPPER.name)).toThrow(/built-in/);
    expect(() => renameMapper(ABS_MAPPER.name, 'x')).toThrow(/built-in/);
  });

  it('upserts by name, renames, deletes, and rejects name collisions', () => {
    saveMapper(CUSTOM);
    saveMapper({ name: CUSTOM.name, columns: { ...CUSTOM.columns, iban: 'Account IBAN' } }); // upsert
    expect(listSaved()).toHaveLength(1);
    expect(listSaved()[0]!.columns.iban).toBe('Account IBAN');

    renameMapper(CUSTOM.name, 'Test Bank 2');
    expect(listSaved().map((m) => m.name)).toEqual(['Test Bank 2']);

    saveMapper({ name: 'Other', columns: CUSTOM.columns });
    expect(() => renameMapper('Test Bank 2', 'other')).toThrow(); // norm() lowercases 'other' vs 'Other'
    expect(() => deleteMapper('nope')).toThrow(/not found/);
    expect(listSaved().map((m) => m.name)).toEqual(['Test Bank 2', 'Other']);
  });

  it('tolerates corrupt localStorage', () => {
    localStorage.setItem('banking.mappers', '{not json');
    expect(listSaved()).toEqual([]);
    saveMapper(CUSTOM); // write recovers the store
    expect(listSaved().map((m) => m.name)).toEqual([CUSTOM.name]);
  });
});
