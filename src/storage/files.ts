import type { CashEntry, Mapper } from '../types';
import { emptyFinance, parseFinance, type FinanceData } from '../finance/model';

/**
 * Uploaded CSV persistence without a server: raw file contents live in
 * IndexedDB together with a snapshot of the mapper used to parse them, so
 * files survive reloads and schema edits without leaving the browser.
 */

const DB_NAME = 'banking';
const DB_VERSION = 3;
const FINANCE_STORE = 'finance_decisions';
const STORE = 'csv_files';
const CASH_STORE = 'cash_entries';

export interface StoredCsv {
  name: string;
  content: string;
  /** mapper snapshot at upload time; null = could not be detected (needs remapping) */
  mapper: Mapper | null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this browser'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'name' });
      if (!db.objectStoreNames.contains(CASH_STORE)) db.createObjectStore(CASH_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(FINANCE_STORE)) db.createObjectStore(FINANCE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('could not open IndexedDB'));
  });
}

export async function loadFinance(): Promise<FinanceData> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(FINANCE_STORE, 'readonly').objectStore(FINANCE_STORE).get('decisions');
      request.onsuccess = () => { try { resolve(request.result === undefined ? emptyFinance() : parseFinance(request.result)); } catch (error) { reject(error); } };
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

export async function saveFinance(data: FinanceData): Promise<void> {
  const validated = parseFinance(data);
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(FINANCE_STORE, 'readwrite');
      tx.objectStore(FINANCE_STORE).put(validated, 'decisions');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Saving finance decisions was aborted'));
    });
  } finally { db.close(); }
}

function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        req.onsuccess = () => {
          resolve(req.result);
          db.close();
        };
        req.onerror = () => {
          reject(req.error ?? new Error('IndexedDB request failed'));
          db.close();
        };
      }),
  );
}

export async function listCsvFiles(): Promise<StoredCsv[]> {
  const all = await withStore<StoredCsv[]>('readonly', (s) => s.getAll() as IDBRequest<StoredCsv[]>);
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

/** same name replaces the previous upload (mapper snapshot included) */
export async function putCsvFile(name: string, content: string, mapper: Mapper | null): Promise<void> {
  await withStore('readwrite', (s) => s.put({ name, content, mapper }));
}

export async function deleteCsvFile(name: string): Promise<void> {
  await withStore('readwrite', (s) => s.delete(name));
}

/** Replace the complete CSV store in one IndexedDB transaction. */
export async function replaceCsvFiles(files: StoredCsv[]): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.clear();
      for (const file of files) store.put(file);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Could not replace stored CSV files'));
      tx.onabort = () => reject(tx.error ?? new Error('Replacing stored CSV files was aborted'));
    });
  } finally {
    db.close();
  }
}

export async function listCashEntries(): Promise<CashEntry[]> {
  const all = await openDb().then((db) => new Promise<CashEntry[]>((resolve, reject) => {
    const req = db.transaction(CASH_STORE, 'readonly').objectStore(CASH_STORE).getAll();
    req.onsuccess = () => { resolve(req.result as CashEntry[]); db.close(); };
    req.onerror = () => { reject(req.error ?? new Error('Could not read cash entries')); db.close(); };
  }));
  return all.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
}

export async function putCashEntry(entry: CashEntry): Promise<void> {
  await openDb().then((db) => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CASH_STORE, 'readwrite');
    tx.objectStore(CASH_STORE).put(entry);
    tx.oncomplete = () => { resolve(); db.close(); };
    tx.onerror = () => { reject(tx.error ?? new Error('Could not save cash entry')); db.close(); };
  }));
}

export async function deleteCashEntry(id: string): Promise<void> {
  await openDb().then((db) => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CASH_STORE, 'readwrite');
    tx.objectStore(CASH_STORE).delete(id);
    tx.oncomplete = () => { resolve(); db.close(); };
    tx.onerror = () => { reject(tx.error ?? new Error('Could not delete cash entry')); db.close(); };
  }));
}

export async function replaceCashEntries(entries: CashEntry[]): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CASH_STORE, 'readwrite');
      const store = tx.objectStore(CASH_STORE);
      store.clear();
      entries.forEach((entry) => store.put(entry));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Could not replace cash entries'));
      tx.onabort = () => reject(tx.error ?? new Error('Replacing cash entries was aborted'));
    });
  } finally { db.close(); }
}
