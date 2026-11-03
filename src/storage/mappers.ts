import type { Mapper } from '../types';
import { KNOWN_SCHEMAS, norm } from '../csv/schemas';

/**
 * Mapper (CSV schema) registry — separate from category settings.
 * Saved custom mappers live in localStorage; the built-in schemas are always
 * offered on top. Stored CSV files embed their own mapper snapshot, so
 * editing/deleting a registry entry never changes already-uploaded files.
 */

const KEY = 'banking.mappers';

interface MappersStore {
  saved: Mapper[];
}

function read(): MappersStore {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as MappersStore;
      if (s && Array.isArray(s.saved)) return s;
    }
  } catch { /* fall through */ }
  return { saved: [] };
}

function write(s: MappersStore): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch (e) {
    throw new Error(`localStorage full or unavailable: ${(e as Error).message}`);
  }
}

export function listSaved(): Mapper[] {
  return read().saved;
}

export function isBuiltin(name: string): boolean {
  return KNOWN_SCHEMAS.some((s) => s.name === name);
}

/** built-in schemas first, then saved ones (name conflicts resolved to the built-in) */
export function allMappers(): Mapper[] {
  const saved = read().saved.filter((m) => !isBuiltin(m.name));
  return [...KNOWN_SCHEMAS, ...saved];
}

export function findMapper(name: string): Mapper | undefined {
  return allMappers().find((m) => m.name === name);
}

/** upsert by exact name; refuses built-ins and case-insensitive collisions with a DIFFERENT mapper */
export function saveMapper(mapper: Mapper): void {
  if (isBuiltin(mapper.name)) throw new Error(`"${mapper.name}" is a built-in schema — use Save as new mapper with a different name`);
  const s = read();
  const i = s.saved.findIndex((m) => m.name === mapper.name);
  if (i < 0 && s.saved.some((m) => norm(m.name) === norm(mapper.name))) {
    throw new Error(`mapper "${mapper.name}" already exists (case differs)`);
  }
  const clone: Mapper = structuredClone(mapper);
  if (i >= 0) s.saved[i] = clone;
  else s.saved.push(clone);
  write(s);
}

export function deleteMapper(name: string): void {
  if (isBuiltin(name)) throw new Error(`"${name}" is a built-in schema and cannot be deleted`);
  const s = read();
  const before = s.saved.length;
  s.saved = s.saved.filter((m) => m.name !== name);
  if (s.saved.length === before) throw new Error(`mapper "${name}" not found`);
  write(s);
}

export function renameMapper(oldName: string, newName: string): void {
  if (isBuiltin(oldName)) throw new Error(`"${oldName}" is a built-in schema and cannot be renamed`);
  newName = newName.trim();
  if (!newName) throw new Error('new mapper name is empty');
  if (isBuiltin(newName) || read().saved.some((m) => m.name !== oldName && norm(m.name) === norm(newName))) {
    throw new Error(`mapper "${newName}" already exists`);
  }
  const s = read();
  const m = s.saved.find((x) => x.name === oldName);
  if (!m) throw new Error(`mapper "${oldName}" not found`);
  m.name = newName;
  write(s);
}
