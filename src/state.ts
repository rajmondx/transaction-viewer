import type { CsvFileInfo, Mapper, Settings, SettingsFileInfo, Tx } from './types';
import { defaultCsvFilter, type CsvFilter } from './ui/search';
import { emptySettings } from './categories/schema';
import * as sstore from './storage/settings';
import { allMappers } from './storage/mappers';
import { deleteCsvFile, listCsvFiles, putCsvFile, type StoredCsv } from './storage/files';
import { ingestFiles, type IngestResult } from './csv/dedupe';
import { detectBestMapper, parseCsvHeaders } from './csv/schemas';
import { toast } from './ui/util';

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
  avgMode: AvgMode;
  /** Share chart: also show each sub-category in a block under its top-level category */
  shareSubs: boolean;
}

function lsKey(name: string): string {
  return `banking.spending.${name}`;
}

export function loadSpendingView(settingsName: string): SpendingView {
  try {
    const raw = localStorage.getItem(lsKey(settingsName));
    if (raw) return { ...defaultSpendingView(), ...(JSON.parse(raw) as SpendingView) };
  } catch { /* ignore */ }
  return defaultSpendingView();
}

export function defaultSpendingView(): SpendingView {
  return { hiddenCats: [], hiddenMonths: [], measure: 'expense', dateFrom: '', dateTo: '', avgMode: 'off', shareSubs: false };
}

export function saveSpendingView(name: string, v: SpendingView): void {
  localStorage.setItem(lsKey(name), JSON.stringify(v));
}

export interface AppState {
  txs: Tx[];
  files: CsvFileInfo[];
  /** raw contents + mapper snapshot of all stored csv files (kept in memory for remap + previews) */
  loaded: StoredCsv[];
  settingsFiles: SettingsFileInfo[];
  activeSettingsName: string;
  settings: Settings;
  csvFilter: CsvFilter;
  spendingView: SpendingView;
  activeTab: 'spending' | 'settings' | 'csv' | 'help';
}

export const state: AppState = {
  txs: [],
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
  listeners.forEach((fn) => fn());
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
  state.txs = result.txs;
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
  state.loaded = await listCsvFiles();
  reingestAll(false);
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
    await migrateStoredFiles();
  } catch {
    state.loaded = []; // no IndexedDB (e.g. private mode): session-only uploads
  }
  if (state.loaded.length > 0) reingestAll(false);
}