import type { CashEntry } from '../types';
import type { StoredCsv } from './files';
import { listCashEntries, listCsvFiles, replaceCashEntries, replaceCsvFiles } from './files';

export const BACKUP_FORMAT = 'transaction-viewer-backup';
export const BACKUP_SCHEMA_VERSION = 2;
const APP_KEY_PREFIX = 'banking.';

export interface AppBackup {
  format: typeof BACKUP_FORMAT;
  schemaVersion: number;
  exportedAt: string;
  data: {
    /** All durable app-owned localStorage values, including settings and preferences. */
    localStorage: Record<string, string>;
    /** Original CSV files and the mapper snapshot used to parse each one. */
    csvFiles: StoredCsv[];
    cashEntries: CashEntry[];
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function validateBackupShape(value: unknown): AppBackup {
  if (!isRecord(value) || value.format !== BACKUP_FORMAT) throw new Error('This is not a Transaction Viewer backup');
  if (!Number.isInteger(value.schemaVersion) || (value.schemaVersion as number) < 1) {
    throw new Error('Backup has an invalid schema version');
  }
  if ((value.schemaVersion as number) > BACKUP_SCHEMA_VERSION) {
    throw new Error(`This backup uses schema version ${value.schemaVersion}, newer than this app supports (version ${BACKUP_SCHEMA_VERSION})`);
  }
  if (!isRecord(value.data) || !isRecord(value.data.localStorage) || !Array.isArray(value.data.csvFiles)) {
    throw new Error('Backup is missing its data, settings, or CSV files');
  }
  if ((value.schemaVersion as number) >= 2 && !Array.isArray(value.data.cashEntries)) {
    throw new Error('Backup is missing its cash entries');
  }

  const localStorage: Record<string, string> = {};
  for (const [key, stored] of Object.entries(value.data.localStorage)) {
    if (!key.startsWith(APP_KEY_PREFIX) || typeof stored !== 'string') {
      throw new Error('Backup contains invalid app settings');
    }
    localStorage[key] = stored;
  }
  const settings = localStorage['banking.settings'];
  if (settings) {
    let parsed: unknown;
    try { parsed = JSON.parse(settings); } catch { throw new Error('Backup category settings are not valid JSON'); }
    if (!isRecord(parsed) || !isRecord(parsed.files) || typeof parsed.active !== 'string') {
      throw new Error('Backup category settings have an invalid format');
    }
  }
  const mappers = localStorage['banking.mappers'];
  if (mappers) {
    let parsed: unknown;
    try { parsed = JSON.parse(mappers); } catch { throw new Error('Backup CSV schemas are not valid JSON'); }
    if (!isRecord(parsed) || !Array.isArray(parsed.saved)) throw new Error('Backup CSV schemas have an invalid format');
  }

  const csvFiles = value.data.csvFiles.map((file, index): StoredCsv => {
    if (!isRecord(file) || typeof file.name !== 'string' || !file.name.trim() || typeof file.content !== 'string') {
      throw new Error(`Backup CSV file ${index + 1} is invalid`);
    }
    if (file.mapper !== null && (!isRecord(file.mapper) || typeof file.mapper.name !== 'string' || !isRecord(file.mapper.columns))) {
      throw new Error(`Backup CSV schema for "${file.name}" is invalid`);
    }
    return { name: file.name, content: file.content, mapper: file.mapper as StoredCsv['mapper'] };
  });
  if (new Set(csvFiles.map((file) => file.name)).size !== csvFiles.length) {
    throw new Error('Backup contains duplicate CSV file names');
  }
  const cashEntriesRaw = Array.isArray(value.data.cashEntries) ? value.data.cashEntries : [];
  const cashEntries = cashEntriesRaw.map((entry, index): CashEntry => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.date !== 'string'
      || (entry.kind !== 'expense' && entry.kind !== 'income' && entry.kind !== 'adjustment') || typeof entry.amount !== 'number'
      || !Number.isFinite(entry.amount) || (entry.kind === 'adjustment' ? entry.amount === 0 : entry.amount <= 0) || typeof entry.category !== 'string'
      || typeof entry.note !== 'string') {
      throw new Error(`Cash entry ${index + 1} in backup is invalid`);
    }
    return entry as unknown as CashEntry;
  });
  if (new Set(cashEntries.map((entry) => entry.id)).size !== cashEntries.length) {
    throw new Error('Backup contains duplicate cash entry IDs');
  }
  return {
    format: BACKUP_FORMAT,
    schemaVersion: value.schemaVersion as number,
    exportedAt: typeof value.exportedAt === 'string' ? value.exportedAt : '',
    data: { localStorage, csvFiles, cashEntries },
  };
}

/** Validate and sequentially migrate backups before they can touch browser storage. */
export function parseBackup(value: unknown): AppBackup {
  const backup = validateBackupShape(value);
  // Keep each future migration explicit and sequential: v1 -> v2 -> v3.
  let current = backup;
  while (current.schemaVersion < BACKUP_SCHEMA_VERSION) {
    switch (current.schemaVersion) {
      case 1:
        current = { ...current, schemaVersion: 2, data: { ...current.data, cashEntries: [] } };
        break;
      default:
        throw new Error(`No migration exists for backup schema version ${current.schemaVersion}`);
    }
  }
  return current;
}

export async function createBackup(): Promise<AppBackup> {
  const localStorage: Record<string, string> = {};
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (key?.startsWith(APP_KEY_PREFIX)) {
      const value = window.localStorage.getItem(key);
      if (value !== null) localStorage[key] = value;
    }
  }
  return {
    format: BACKUP_FORMAT,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    data: { localStorage, csvFiles: await listCsvFiles(), cashEntries: await listCashEntries() },
  };
}

/** Restore all app-owned state. Roll back both stores if either write fails. */
export async function restoreBackup(backup: AppBackup): Promise<void> {
  const previousFiles = await listCsvFiles();
  const previousCash = await listCashEntries();
  const previousStorage: Record<string, string> = {};
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (key?.startsWith(APP_KEY_PREFIX)) {
      const value = window.localStorage.getItem(key);
      if (value !== null) previousStorage[key] = value;
    }
  }

  const replaceLocalStorage = (values: Record<string, string>): void => {
    const keys = Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i))
      .filter((key): key is string => !!key && key.startsWith(APP_KEY_PREFIX));
    for (const key of keys) window.localStorage.removeItem(key);
    for (const [key, value] of Object.entries(values)) window.localStorage.setItem(key, value);
  };

  try {
    await replaceCsvFiles(backup.data.csvFiles);
    await replaceCashEntries(backup.data.cashEntries);
    replaceLocalStorage(backup.data.localStorage);
  } catch (error) {
    try {
      await replaceCsvFiles(previousFiles);
      await replaceCashEntries(previousCash);
      replaceLocalStorage(previousStorage);
    } catch (rollbackError) {
      throw new Error(`Restore failed (${String(error)}); rollback also failed (${String(rollbackError)}). Reload and check your data.`);
    }
    throw new Error(`Restore failed; your previous data was kept. ${String(error)}`);
  }
}
