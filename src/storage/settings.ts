import type { Settings, SettingsFileInfo } from '../types';
import { parseSettings, seedSettings, serializeSettings } from '../categories/schema';

/**
 * Category-settings persistence without a server: all bundles ({ name,
 * categories }) live in one localStorage document. CSV files are separate
 * (storage/files.ts) and the mapper registry too (storage/mappers.ts).
 */

const KEY = 'banking.settings';

export interface SettingsStore {
  active: string;
  files: Record<string, Settings>;
}

function seedStore(): SettingsStore {
  const def = seedSettings();
  return { active: def.name, files: { [def.name]: def } };
}

function isSafeName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,80}$/.test(name) && !name.includes('..');
}

function read(): SettingsStore {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as SettingsStore;
      if (s && s.files && typeof s.files === 'object') {
        if (!s.files[s.active]) s.active = Object.keys(s.files)[0] ?? 'default';
        return s;
      }
    }
  } catch { /* fall through to seed */ }
  const s = seedStore();
  write(s);
  return s;
}

function write(s: SettingsStore): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch (e) {
    throw new Error(`localStorage full or unavailable: ${(e as Error).message}`);
  }
}

/** list bundles; 'default' first, then by name */
export function listSettings(): SettingsFileInfo[] {
  const s = read();
  const names = Object.keys(s.files).sort((a, b) => (a === b ? 0 : a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)));
  return names.map((name) => ({ name, isDefault: name === 'default' }));
}

export function getSettingsObj(name: string): Settings | null {
  return read().files[name] ?? null;
}

/** stored bundle re-serialized to file text (for the raw JSON editor / export) */
export function getSettingsText(name: string): string | null {
  const s = getSettingsObj(name);
  return s ? serializeSettings(s) : null;
}

export function getActiveName(): string {
  return read().active;
}

export function setActiveName(name: string): void {
  const s = read();
  if (!s.files[name]) throw new Error(`settings "${name}" not found`);
  s.active = name;
  write(s);
}

/** validate + store a bundle from JSON text; returns the parsed bundle */
export function putSettingsText(name: string, text: string): Settings {
  if (!isSafeName(name)) throw new Error(`invalid settings name "${name}"`);
  const parsed = parseSettings(text, name);
  const s = read();
  s.files[name] = { ...parsed, name };
  write(s);
  return s.files[name];
}

export function putSettingsObj(settings: Settings): void {
  if (!isSafeName(settings.name)) throw new Error(`invalid settings name "${settings.name}"`);
  const s = read();
  s.files[settings.name] = settings;
  write(s);
}

export function deleteSettings(name: string): void {
  const s = read();
  if (!s.files[name]) throw new Error(`settings "${name}" not found`);
  if (name === 'default') throw new Error('the default settings file cannot be deleted');
  delete s.files[name];
  if (s.active === name) s.active = s.files.default ? 'default' : Object.keys(s.files)[0] ?? 'default';
  write(s);
}

/** copy a bundle's content into the "default" bundle */
export function setDefault(name: string): void {
  const s = read();
  const src = s.files[name];
  if (!src) throw new Error(`settings "${name}" not found`);
  s.files.default = { ...structuredClone(src), name: 'default' };
  write(s);
}
