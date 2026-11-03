import type { Mapper } from '../types';

/**
 * Uploaded CSV persistence without a server: raw file contents live in
 * IndexedDB together with a snapshot of the mapper used to parse them, so
 * files survive reloads and schema edits without leaving the browser.
 */

const DB_NAME = 'banking';
const DB_VERSION = 1;
const STORE = 'csv_files';

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
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('could not open IndexedDB'));
  });
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
