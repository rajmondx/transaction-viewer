import { describe, expect, it } from 'vitest';
import { BACKUP_FORMAT, BACKUP_SCHEMA_VERSION, parseBackup, type AppBackup } from '../src/storage/backup';

const validBackup = (): AppBackup => ({
  format: BACKUP_FORMAT,
  schemaVersion: BACKUP_SCHEMA_VERSION,
  exportedAt: '2026-11-05T12:00:00.000Z',
  data: {
    localStorage: {
      'banking.settings': JSON.stringify({ active: 'default', files: { default: { name: 'default', categories: [] } } }),
      'banking.theme': 'dark',
    },
    csvFiles: [{ name: 'statement.csv', content: 'Date,Text,Amount\n', mapper: null }],
    cashEntries: [],
  },
});

describe('parseBackup', () => {
  it('accepts and normalizes a valid full backup', () => {
    expect(parseBackup(validBackup())).toMatchObject({
      format: BACKUP_FORMAT,
      schemaVersion: BACKUP_SCHEMA_VERSION,
      data: { localStorage: { 'banking.theme': 'dark' }, csvFiles: [{ name: 'statement.csv' }] },
    });
  });

  it('rejects an unsupported future schema without attempting to import it', () => {
    expect(() => parseBackup({ ...validBackup(), schemaVersion: BACKUP_SCHEMA_VERSION + 1 }))
      .toThrow(/newer than this app supports/);
  });

  it('migrates version 1 backups without cash entries and preserves current cash entries', () => {
    const legacy = validBackup();
    legacy.schemaVersion = 1;
    delete (legacy.data as Partial<typeof legacy.data>).cashEntries;
    expect(parseBackup(legacy).data.cashEntries).toEqual([]);
    const current = validBackup();
    current.data.cashEntries = [{ id: 'cash-1', date: '2026-01-02', kind: 'expense', amount: 5, category: 'Food', note: 'Lunch' }];
    expect(parseBackup(current).data.cashEntries).toEqual(current.data.cashEntries);
  });

  it('rejects unrelated JSON and app data outside its namespace', () => {
    expect(() => parseBackup({ hello: 'world' })).toThrow(/not a Transaction Viewer backup/);
    expect(() => parseBackup({ ...validBackup(), data: { ...validBackup().data, localStorage: { unrelated: 'value' } } }))
      .toThrow(/invalid app settings/);
  });

  it('rejects malformed CSV entries and malformed settings stores', () => {
    expect(() => parseBackup({
      ...validBackup(), data: { ...validBackup().data, csvFiles: [{ name: 'broken.csv' }] },
    })).toThrow(/CSV file 1 is invalid/);
    expect(() => parseBackup({
      ...validBackup(), data: { ...validBackup().data, localStorage: { 'banking.settings': '{' } },
    })).toThrow(/not valid JSON/);
  });
});
