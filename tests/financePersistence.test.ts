import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyFinance } from '../src/finance/model';

const stores = vi.hoisted(() => ({
  listCsvFiles: vi.fn(), listCashEntries: vi.fn(), loadFinance: vi.fn(),
  replaceCsvFiles: vi.fn(), replaceCashEntries: vi.fn(), saveFinance: vi.fn(),
}));
vi.mock('../src/storage/files', () => stores);

beforeEach(() => {
  vi.resetAllMocks();
  const memory = new Map<string, string>();
  const storage = {
    get length() { return memory.size; }, key: (i: number) => [...memory.keys()][i] ?? null,
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, value); }, removeItem: (key: string) => { memory.delete(key); },
  };
  vi.stubGlobal('window', { localStorage: storage }); vi.stubGlobal('localStorage', storage);
  stores.listCsvFiles.mockResolvedValue([{ name: 'old.csv', content: 'old', mapper: null }]);
  stores.listCashEntries.mockResolvedValue([]);
  stores.loadFinance.mockResolvedValue(emptyFinance());
  stores.replaceCsvFiles.mockResolvedValue(undefined); stores.replaceCashEntries.mockResolvedValue(undefined); stores.saveFinance.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe('finance restore safety', () => {
  it('validates finance payloads before any replacement', async () => {
    const { restoreBackup } = await import('../src/storage/backup');
    await expect(restoreBackup({ format: 'transaction-viewer-backup', schemaVersion: 3, exportedAt: '', data: { localStorage: {}, csvFiles: [], cashEntries: [], finance: { version: 99 } } } as never)).rejects.toThrow();
    expect(stores.replaceCsvFiles).not.toHaveBeenCalled(); expect(stores.saveFinance).not.toHaveBeenCalled();
  });
  it('rolls back every store if finance persistence fails', async () => {
    const { restoreBackup } = await import('../src/storage/backup');
    localStorage.setItem('banking.theme', 'dark');
    stores.saveFinance.mockRejectedValueOnce(new Error('quota'));
    await expect(restoreBackup({ format: 'transaction-viewer-backup', schemaVersion: 3, exportedAt: '', data: { localStorage: { 'banking.theme': 'light' }, csvFiles: [], cashEntries: [], finance: emptyFinance() } })).rejects.toThrow(/previous data was kept/);
    expect(stores.replaceCsvFiles).toHaveBeenLastCalledWith([{ name: 'old.csv', content: 'old', mapper: null }]);
    expect(stores.replaceCashEntries).toHaveBeenCalledTimes(2); expect(stores.saveFinance).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem('banking.theme')).toBe('dark');
  });
  it('exports finance alongside existing stores', async () => {
    const { createBackup, parseBackup } = await import('../src/storage/backup');
    const finance = emptyFinance(); finance.rejectedTransfers = ['rejected']; stores.loadFinance.mockResolvedValue(finance);
    expect(parseBackup(await createBackup()).data.finance).toEqual(finance);
  });
});
