import type { CashEntry, CsvFileInfo, Mapper, Settings, SettingsFileInfo, Tx } from './types';
import { defaultCsvFilter, type CsvFilter } from './ui/search';
import { emptySettings, parseSettings, serializeSettings } from './categories/schema';
import * as sstore from './storage/settings';
import { allMappers } from './storage/mappers';
import { deleteCashEntry, deleteCsvFile, listCashEntries, listCsvFiles, putCashEntry, putCsvFile, replaceCashEntries, type StoredCsv } from './storage/files';
import { ingestFiles, type IngestResult } from './csv/dedupe';
import { detectBestMapper, parseCsvHeaders } from './csv/schemas';
import { DEMO_FILE_NAME } from './seed/demoCsv';
import { withoutDemoCashEntries } from './seed/demoCash';
import { toast } from './ui/util';
import { emptyFinance, parseFinance, renameFinanceCategories, type FinanceData } from './finance/model';
import { annotateRows } from './finance/reporting';
import { loadFinance, saveFinance } from './storage/files';

/**
 * Average display mode (mutually exclusive — each turns the other off):
 * - 'off'    : plain category × month matrix
 * - 'column' : extra 'Average' column next to Total
 * - 'only'   : month columns hidden — Category | Total | Average
 */
export type AvgMode = 'off' | 'column' | 'only';

export interface SpendingView {
  hiddenCats: string[];
  hiddenMonths: string[];
  measure: 'expense' | 'income' | 'net';
  dateFrom: string;
  dateTo: string;
  /** Limit the Spending aggregates and drill-downs to one transaction source
   *  (Cash | Bank | All toolbar buttons). 'cash' = manually recorded entries
   *  only, 'bank' = imported bank rows only, 'both' = everything. Same values
   *  as the CSV filter's source. */
  source: 'cash' | 'bank' | 'both';
  /** Cash-movement category tags the user chose to count in Spending totals.
   *  Cash transfers stay visible in the table but are excluded by default —
   *  the money moves into the wallet, it is only spent when recorded there. */
  cashInSpending: string[];
  avgMode: AvgMode;
  /** Share chart: also show each sub-category in a block under its top-level category */
  shareSubs: boolean;
  /** horizontal freezing of each static column, toggled by clicking its header.
   *  A missing key = automatic for that column (pinned on desktop, free on tablet
   *  and below); clicking a header stores an explicit choice just for that column. */
  pinStatic?: Partial<Record<'cat' | 'avg' | 'total', boolean>>;
}

function lsKey(name: string): string {
  return `banking.spending.${name}`;
}

export function loadSpendingView(settingsName: string): SpendingView {
  try {
    const raw = localStorage.getItem(lsKey(settingsName));
    if (raw) {
      const parsed = JSON.parse(raw) as SpendingView & { cashOnly?: boolean };
      const v: SpendingView & { cashOnly?: boolean } = { ...defaultSpendingView(), ...parsed };
      if (!Array.isArray(v.cashInSpending)) v.cashInSpending = [];
      // older builds stored a "Cash Only" checkbox instead of the Cash | Bank | All group
      if (parsed.source === undefined && parsed.cashOnly !== undefined) v.source = parsed.cashOnly ? 'cash' : 'both';
      if (v.source !== 'cash' && v.source !== 'bank' && v.source !== 'both') v.source = 'both';
      delete v.cashOnly;
      // older builds stored one boolean freezing all three static columns at once
      if (typeof (v.pinStatic as unknown) === 'boolean') {
        const b = v.pinStatic as unknown as boolean;
        v.pinStatic = { cat: b, avg: b, total: b };
      }
      return v;
    }
  } catch { /* ignore */ }
  return defaultSpendingView();
}

export function defaultSpendingView(): SpendingView {
  return { hiddenCats: [], hiddenMonths: [], measure: 'expense', dateFrom: '', dateTo: '', source: 'both', cashInSpending: [], avgMode: 'off', shareSubs: false };
}

export function saveSpendingView(name: string, v: SpendingView): void {
  localStorage.setItem(lsKey(name), JSON.stringify(v));
}

export interface AppState {
  finance: FinanceData;
  txs: Tx[];
  cashEntries: CashEntry[];
  files: CsvFileInfo[];
  /** raw contents + mapper snapshot of all stored csv files (kept in memory for remap + previews) */
  loaded: StoredCsv[];
  settingsFiles: SettingsFileInfo[];
  activeSettingsName: string;
  settings: Settings;
  csvFilter: CsvFilter;
  spendingView: SpendingView;
  activeTab: 'spending' | 'settings' | 'csv' | 'help' | 'finance';
}

export const state: AppState = {
  finance: emptyFinance(),
  txs: [],
  cashEntries: [],
  files: [],
  loaded: [],
  settingsFiles: [],
  activeSettingsName: 'default',
  settings: emptySettings('default'),
  csvFilter: defaultCsvFilter(),
  spendingView: defaultSpendingView(),
  activeTab: 'spending',
};

/** listeners */
const listeners = new Set<() => void>();
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function emit(): void {
  state.txs = annotateRows(state.txs, state.finance, state.settings);
  listeners.forEach((fn) => fn());
}

/** Persist first; a failed write must not look like a successful edit. */
let financeWrites: Promise<void> = Promise.resolve();
let financeReadOnly = false;
export function updateFinance(change: (data: FinanceData) => void): Promise<void> {
  const task = financeWrites.then(async () => {
    if (financeReadOnly) throw new Error('Finance decisions could not be loaded. Reload or restore a backup before editing them.');
    const next = structuredClone(state.finance);
    change(next);
    const committed = parseFinance(next); // detach editor-owned arrays before async persistence
    await saveFinance(committed);
    state.finance = committed;
    emit();
  });
  financeWrites = task.catch(() => {});
  return task;
}

export async function saveCategorySettings(settings: Settings, renames: Array<[string, string]>): Promise<void> {
  settings = parseSettings(serializeSettings(settings), settings.name);
  const next = structuredClone(state.finance);
  renameFinanceCategories(next, settings.name, renames);
  const changed = JSON.stringify(next) !== JSON.stringify(state.finance);
  const previous = state.finance;
  if (changed) await updateFinance((data) => renameFinanceCategories(data, settings.name, renames));
  try { sstore.putSettingsObj(settings); }
  catch (error) {
    if (changed) { await saveFinance(previous); state.finance = previous; }
    throw error;
  }
  state.settings = structuredClone(settings);
  emit();
}

export function reloadSettingsList(): void {
  state.settingsFiles = sstore.listSettings();
  let active = sstore.getActiveName();
  if (!state.settingsFiles.some((f) => f.name === active)) {
    active = state.settingsFiles.find((f) => f.isDefault)?.name ?? state.settingsFiles[0]?.name ?? 'default';
    try { sstore.setActiveName(active); } catch { /* ignore */ }
  }
  state.activeSettingsName = active;
}

export function loadActiveSettings(): void {
  const name = state.activeSettingsName;
  const loaded = sstore.getSettingsObj(name);
  if (loaded) {
    state.settings = loaded;
  } else {
    state.settings = emptySettings(name);
    toast(`Could not load settings "${name}"`, 'err');
  }
  state.spendingView = loadSpendingView(name);
}

/** Category settings and CSV mappers are independent — switching settings only reclassifies. */
export async function selectSettings(name: string): Promise<void> {
  state.activeSettingsName = name;
  sstore.setActiveName(name);
  loadActiveSettings();
  emit();
}

/**
 * Re-parse every stored file with the mapper snapshot it was uploaded with
 * (per-file mappers; overlapping files dedup, see csv/dedupe.ts).
 */
export function reingestAll(notify = true): IngestResult {
  const result = ingestFiles(state.loaded);
  state.files = result.files;
  state.txs = annotateRows(result.txs, state.finance, state.settings);
  if (result.warnings.length > 0) console.warn('CSV warnings:', result.warnings);
  if (notify) {
    if (result.needsMapper.length > 0) {
      toast(`${result.needsMapper.length === 1 ? result.needsMapper[0] : `${result.needsMapper.length} files`} need${result.needsMapper.length === 1 ? 's' : ''} a CSV schema — open "Mappers…"`, 'err');
    } else {
      toast(`${state.txs.length} transactions loaded`);
    }
  }
  return result;
}

/** Store files with their chosen mapper snapshots, then re-ingest everything. */
export async function addUploads(items: Array<{ name: string; content: string; mapper: Mapper | null }>): Promise<void> {
  for (const it of items) {
    try {
      await putCsvFile(it.name, it.content, it.mapper);
    } catch (e) {
      toast(`Storing ${it.name} failed: ${String(e)}`, 'err');
    }
  }
  state.loaded = await listCsvFiles();
  reingestAll(true);
  emit();
}

export async function removeFile(name: string): Promise<void> {
  await deleteCsvFile(name);
  if (name === DEMO_FILE_NAME) {
    const cashEntries = await listCashEntries();
    const remaining = withoutDemoCashEntries(cashEntries);
    if (remaining.length !== cashEntries.length) await replaceCashEntries(remaining);
    state.cashEntries = remaining;
  }
  state.loaded = await listCsvFiles();
  reingestAll(false);
  emit();
}

export async function saveCashEntry(entry: CashEntry): Promise<void> {
  await putCashEntry(entry);
  state.cashEntries = await listCashEntries();
  emit();
}

export async function removeCashEntry(id: string): Promise<void> {
  await deleteCashEntry(id);
  state.cashEntries = await listCashEntries();
  emit();
}

/** Legacy records (pre-mapper) get their schema auto-detected once, then re-stored. */
async function migrateStoredFiles(): Promise<void> {
  let changed = false;
  for (const f of state.loaded) {
    const rec = f as StoredCsv & { mapper?: unknown };
    if ('mapper' in rec && (rec.mapper === null || typeof rec.mapper === 'object')) continue;
    const headers = parseCsvHeaders(f.content);
    const best = detectBestMapper(headers, allMappers());
    rec.mapper = best ? best.mapper : null;
    await putCsvFile(f.name, f.content, rec.mapper);
    changed = true;
  }
  if (changed) state.loaded = await listCsvFiles();
}

export async function bootstrap(): Promise<void> {
  reloadSettingsList();
  loadActiveSettings();
  try {
    state.loaded = await listCsvFiles();
    state.cashEntries = await listCashEntries();
    await migrateStoredFiles();
  } catch {
    state.loaded = []; // no IndexedDB (e.g. private mode): session-only uploads
  }
  try { state.finance = await loadFinance(); financeReadOnly = false; }
  catch (error) { financeReadOnly = true; toast(`Could not load saved finance decisions: ${String(error)}. Existing decisions will not be overwritten.`, 'err'); }
  if (state.loaded.length > 0) reingestAll(false);
}
