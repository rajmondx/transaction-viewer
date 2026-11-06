import type { Category, SearchRule, Settings } from '../types';
import { normalizeIban } from '../csv/parse';
import { colorFor } from '../ui/util';
import seedJson from '../seed/default-category-setting.json';

/**
 * Tolerant parser for the user-facing category JSON format.
 *
 * Accepts (per file, both key styles):
 *   tag | name                      — category name
 *   tag_father | tagFather | parent — parent category name (null when absent)
 *   iban | ibans                    — array of IBAN strings (normalized)
 *   search_tag | searchTags | rules — array of entries, each one of:
 *       "Miete"                     — plain text (default: case-insensitive substring)
 *       "case_insensitive" | "case_insentive" | "case_sensitive"
 *       "fuzzy" | "plain" | "regex" — flag tokens; apply to all FOLLOWING plain texts
 *       { "text": "Miete", "case_insensitive": true, "case_sensitive": false,
 *         "fuzzy": false, "regex": false }
 *   date_from | dateFrom, date_to | dateTo — ISO yyyy-mm-dd strings (Buchungsdatum range)
 *   enabled                         — default true
 *   color                           — hex
 */

const FLAG_TOKENS: Record<string, Partial<SearchRule>> = {
  case_insensitive: { caseSensitive: false },
  caseinsensitive: { caseSensitive: false },
  case_insentive: { caseSensitive: false }, // tolerated typo from the spec sketch
  caseinsentive: { caseSensitive: false },
  case_sensitive: { caseSensitive: true },
  casesensitive: { caseSensitive: true },
  fuzzy: { fuzzy: true },
  plain: { fuzzy: false, regex: false },
  contains: { fuzzy: false, regex: false },
  regex: { regex: true },
};

function flagFor(token: string): Partial<SearchRule> | null {
  const k = token.toLowerCase().replace(/[\s-]/g, '_');
  return FLAG_TOKENS[k] ?? null;
}

function parseRuleEntry(entry: unknown, mode: { caseSensitive: boolean; fuzzy: boolean; regex: boolean }): SearchRule | null {
  if (typeof entry === 'string') {
    const flag = flagFor(entry);
    if (flag) {
      Object.assign(mode, flag);
      return null;
    }
    return { text: entry, caseSensitive: mode.caseSensitive, fuzzy: mode.fuzzy, regex: mode.regex };
  }
  if (entry && typeof entry === 'object') {
    const o = entry as Record<string, unknown>;
    const text = String(o.text ?? o.search ?? '');
    const cs = o.case_sensitive ?? o.caseSensitive;
    const ci = o.case_insensitive ?? o.caseInsensitive ?? o.case_insentive;
    const caseSensitive = cs === true ? true : ci === true ? false : mode.caseSensitive;
    const fuzzy = o.fuzzy === undefined ? mode.fuzzy : Boolean(o.fuzzy);
    const regex = o.regex === undefined ? mode.regex : Boolean(o.regex);
    if (text === '') return null;
    return { text, caseSensitive, fuzzy, regex };
  }
  return null;
}

function parseIso(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

export function parseCategory(raw: unknown, i: number): Category {
  const o = (raw ?? {}) as Record<string, unknown>;
  const tag = String(o.tag ?? o.name ?? `Category ${i + 1}`).trim();
  const father = o.tag_father ?? o.tagFather ?? o.parent;
  const ibanRaw = (o.iban ?? o.ibans ?? []) as unknown;
  const ibans = Array.isArray(ibanRaw)
    ? ibanRaw.map((x) => normalizeIban(String(x))).filter((x) => x !== '')
    : [];
  const rulesRaw = (o.search_tag ?? o.searchTags ?? o.rules ?? []) as unknown;
  const mode = { caseSensitive: false, fuzzy: false, regex: false };
  const rules: SearchRule[] = [];
  if (Array.isArray(rulesRaw)) {
    for (const entry of rulesRaw) {
      const r = parseRuleEntry(entry, mode);
      if (r) rules.push(r);
    }
  } else if (typeof rulesRaw === 'string' && rulesRaw.trim() !== '') {
    const r = parseRuleEntry(rulesRaw, mode);
    if (r) rules.push(r);
  }
  const color = typeof o.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(o.color) ? o.color : colorFor(i);
  return {
    tag,
    tagFather: father == null || String(father).trim() === '' ? null : String(father).trim(),
    color,
    ibans,
    rules,
    dateFrom: parseIso(o.date_from ?? o.dateFrom),
    dateTo: parseIso(o.date_to ?? o.dateTo),
    enabled: o.enabled === false ? false : true,
    cashMovement: o.cash_movement === 'withdrawal' || o.cash_movement === 'deposit' ? o.cash_movement : null,
  };
}

/** Parse a category-settings JSON. A stray `mapper` key (from older exports) is ignored. */
export function parseSettings(jsonText: string, fallbackName: string): Settings {
  const data = JSON.parse(jsonText) as Record<string, unknown>;
  const catsRaw = data.categories ?? data.Categories;
  if (!Array.isArray(catsRaw)) throw new Error('JSON has no "categories" array');
  const name = typeof data.name === 'string' && data.name ? data.name : fallbackName;
  return { name, categories: catsRaw.map((c, i) => parseCategory(c, i)) };
}

/** Serialize back to the user-facing settings.json format: { name, categories }. */
export function serializeSettings(s: Settings): string {
  const out = {
    name: s.name === 'default' ? 'default' : s.name,
    categories: s.categories.map((c) => {
      const o: Record<string, unknown> = { tag: c.tag };
      if (c.tagFather) o.tag_father = c.tagFather;
      o.color = c.color;
      o.iban = c.ibans;
      o.search_tag = c.rules.map((r) => {
        const special = r.caseSensitive || r.fuzzy || r.regex;
        if (!special) return r.text;
        const ro: Record<string, unknown> = { text: r.text };
        if (r.caseSensitive) ro.case_sensitive = true;
        if (r.fuzzy) ro.fuzzy = true;
        if (r.regex) ro.regex = true;
        return ro;
      });
      if (c.dateFrom) o.date_from = c.dateFrom;
      if (c.dateTo) o.date_to = c.dateTo;
      if (!c.enabled) o.enabled = false;
      if (c.cashMovement) o.cash_movement = c.cashMovement;
      return o;
    }),
  };
  return JSON.stringify(out, null, 2);
}

export function emptySettings(name: string): Settings {
  return { name, categories: [] };
}

/** The seed "default" bundle shipped with the app (starter categories). */
export function seedSettings(): Settings {
  return parseSettings(JSON.stringify(seedJson), 'default');
}
