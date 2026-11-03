import type { Mapper } from '../types';
import { parseMapper } from '../csv/schemas';
import { isBuiltin, saveMapper } from '../storage/mappers';
import * as sstore from '../storage/settings';
import { reloadSettingsList, selectSettings } from '../state';
import { toast } from './util';

/**
 * Dropping a .json file anywhere on the page imports it, and the app figures
 * out on its own which kind of JSON it is — so nobody has to remember which of
 * the two import buttons a file belongs to:
 *
 * - category settings: `{ name, categories: [...] }`, a bare array of
 *   categories, or a full `{ active, files: { name → bundle } }` dump
 * - CSV schema:        `{ name, columns: {...} }` or an array of those
 */

export type JsonKind = 'settings' | 'mappers' | 'unknown';

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** one mapper: { name, columns: { bookingDate, text, ... } } */
function isMapperLike(v: unknown): boolean {
  if (!isRecord(v) || !isRecord(v.columns)) return false;
  return Object.values(v.columns as Record<string, unknown>).some((x) => typeof x === 'string' && x !== '');
}

/** one category row: a name plus at least one of the rule-ish keys */
function isCategoryLike(v: unknown): boolean {
  if (!isRecord(v)) return false;
  const hasTag = typeof v.tag === 'string' || typeof v.name === 'string';
  const hasRules = ['search_tag', 'searchTags', 'rules', 'iban', 'ibans', 'tag_father', 'tagFather', 'parent', 'color'].some((k) => k in v);
  return hasTag && hasRules;
}

const hasCategoriesArray = (v: unknown): boolean => {
  if (!isRecord(v)) return false;
  const cats = v.categories ?? v.Categories;
  return Array.isArray(cats);
};

/** what kind of JSON is this? */
export function classifyJson(data: unknown): JsonKind {
  if (Array.isArray(data)) {
    if (data.some(isCategoryLike)) return 'settings';
    if (data.some(isMapperLike)) return 'mappers';
    return 'unknown';
  }
  if (!isRecord(data)) return 'unknown';
  if (hasCategoriesArray(data)) return 'settings';
  // a whole settings store: { active, files: { name → { name, categories } } }
  if (isRecord(data.files) && Object.values(data.files).some(hasCategoriesArray)) return 'settings';
  if (isMapperLike(data)) return 'mappers';
  if (Array.isArray(data.saved) && data.saved.some(isMapperLike)) return 'mappers';
  return 'unknown';
}

const baseName = (fileName: string): string => fileName.replace(/\.json$/i, '').trim() || 'imported';

/** store one bundle; asks before replacing an existing file */
function importBundle(name: string, jsonText: string): boolean {
  if (sstore.listSettings().some((f) => f.name === name) && !confirm(`Settings "${name}" already exists — replace it with the dropped file?`)) {
    toast(`Import of "${name}" cancelled`);
    return false;
  }
  try {
    const parsed = sstore.putSettingsText(name, jsonText); // validates + normalizes
    reloadSettingsList();
    void selectSettings(name);
    // show the result: the Categories page is where a settings import is meaningful
    if (location.hash !== '#categories') location.hash = '#categories';
    toast(`Imported categories "${name}" (${parsed.categories.length} categories)`);
    return true;
  } catch (e) {
    toast(`Import failed: ${(e as Error).message}`, 'err');
    return false;
  }
}

function importCategories(name: string, cats: unknown[]): void {
  importBundle(name, JSON.stringify({ name, categories: cats }));
}

/** { active, files } dump — every bundle inside gets imported */
function importSettingsStore(data: Record<string, unknown>, fileName: string): void {
  const files = data.files as Record<string, unknown>;
  const names = Object.keys(files).filter((n) => hasCategoriesArray(files[n]));
  let done = 0;
  for (const n of names) {
    const cats = (files[n] as Record<string, unknown>).categories;
    if (!Array.isArray(cats)) continue;
    if (importBundle(n, JSON.stringify({ name: n, categories: cats }))) done++;
  }
  if (done === 0) toast(`${fileName}: no usable settings bundle inside`, 'err');
}

function importSettingsFile(fileName: string, data: unknown): void {
  if (Array.isArray(data)) {
    importCategories(baseName(fileName), data);
    return;
  }
  if (!isRecord(data)) return;
  if (isRecord(data.files) && Object.values(data.files).some(hasCategoriesArray)) {
    importSettingsStore(data, fileName);
    return;
  }
  const cats = data.categories ?? data.Categories;
  if (!Array.isArray(cats)) {
    toast(`${fileName}: no "categories" array found`, 'err');
    return;
  }
  const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : baseName(fileName);
  importCategories(name, cats);
}

function importMapperFile(fileName: string, data: unknown): void {
  const list: unknown[] = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.saved)
      ? (data.saved as unknown[])
      : [data];
  const wanted = list.filter(isMapperLike).length;
  if (wanted === 0) {
    toast(`${fileName}: no "columns" mapping found — that is not a CSV schema`, 'err');
    return;
  }
  let saved = 0;
  const problems: string[] = [];
  for (const item of list) {
    if (!isMapperLike(item)) continue;
    const raw = item as Record<string, unknown>;
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : baseName(fileName);
    // parseMapper falls back to the built-in schema when required columns are missing
    const parsed: Mapper = parseMapper(item);
    if (parsed.name !== name) {
      problems.push(`"${name}" is missing required columns (booking date, description, credit/debit or amount)`);
      continue;
    }
    if (isBuiltin(parsed.name)) {
      problems.push(`"${parsed.name}" is a built-in schema`);
      continue;
    }
    try {
      saveMapper(parsed);
      saved++;
    } catch (e) {
      problems.push((e as Error).message);
    }
  }
  if (saved > 0) toast(`Imported ${saved} CSV schema${saved === 1 ? '' : 's'} — offered on the next upload`);
  if (problems.length > 0) toast(problems.join('; '), saved > 0 ? 'ok' : 'err');
}

/** one dropped JSON file: recognized, imported and reported */
export async function importJsonFile(file: File): Promise<void> {
  const text = await file.text();
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch (e) {
    toast(`${file.name} is not valid JSON: ${(e as Error).message}`, 'err');
    return;
  }
  const kind = classifyJson(data);
  if (kind === 'settings') importSettingsFile(file.name, data);
  else if (kind === 'mappers') importMapperFile(file.name, data);
  else toast(`${file.name} is neither category settings nor a CSV schema (no "categories" / "columns")`, 'err');
}

