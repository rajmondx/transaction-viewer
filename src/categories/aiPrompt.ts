import type { Settings, Tx } from '../types';

/**
 * Prompt builder for "Let AI write the categories".
 *
 * The app never talks to an AI itself: it produces a prompt the user pastes
 * into whichever assistant they use, optionally carrying their own transactions.
 * Because a full statement can be long, `simplifyTxs` collapses it — per IBAN,
 * rows whose description is at least 50 % identical become one row — and the
 * result is capped so the prompt stays affordable.
 */

/** at most this many transaction lines go into the prompt */
export const AI_LINE_LIMIT = 150;
/** descriptions shorter than this are passed through unchanged */
export const AI_PASSTHROUGH_LIMIT = 150;

export interface PromptLine {
  /** IBAN shown to the user (spaces kept) */
  iban: string;
  /** description, shortened to one informative line */
  text: string;
  /** how many transactions this row stands for */
  count: number;
  credit: number;
  debit: number;
}

/** "Bahnhofstrasse 12" / "12 Bahnhofstrasse" — street + house number */
const ADDRESS = /(strasse|straße|street|weg|route|platz|allee|gasse|chaussee|avenue|road)\s?\d|\d\s+(strasse|straße|street|weg|route|platz|allee|gasse|chaussee)/i;
/** "8001 Zurich" — postcode followed by the place */
const POSTCODE_CITY = /^\d{3,5}\s+\S/;

/** drop address segments, keep the payee and the purpose, cap the length */
export function compactText(raw: string): string {
  const segments = raw
    .split('⏐')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s !== '');
  const keep = segments.filter((s) => !POSTCODE_CITY.test(s) && !ADDRESS.test(s));
  const usable = keep.length > 0 ? keep : segments;
  // too many lines: payee (first two) plus the last one, which is the payment purpose
  const chosen = usable.length <= 3 ? usable : [usable[0], usable[1], usable[usable.length - 1]];
  const joined = chosen.join(' | ');
  return joined.length > 140 ? `${joined.slice(0, 139)}…` : joined;
}

/** words that identify a payee: long enough, and not a number/date/amount token */
function coreTokens(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-zäöüß0-9]+/)
        .filter((t) => t.length >= 3 && !/\d/.test(t)),
    ),
  );
}

/**
 * Similarity of two descriptions: Jaccard overlap of their payee words (0..1).
 * Symmetric, so a longer line only merges with another when most of its words
 * agree — that keeps "Debit card ... MIGROS" and "Debit card ... SBB" apart
 * while merging the same payee across dates and amounts.
 */
export function similarity(a: string, b: string): number {
  const ta = coreTokens(a);
  const tb = coreTokens(b);
  if (ta.length === 0 || tb.length === 0) return a.trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0;
  const setA = new Set(ta);
  const setB = new Set(tb);
  let shared = 0;
  for (const t of setA) if (setB.has(t)) shared++;
  const union = setA.size + setB.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** two rows are "the same kind of line" from 50 % identical text on */
export const SIMILAR_MERGE_AT = 0.5;

const asLine = (t: Tx): PromptLine => ({
  iban: t.ibanDisplay || t.iban,
  text: compactText(t.text),
  count: 1,
  credit: t.credit,
  debit: t.debit,
});

/**
 * Shrink a transaction list for the prompt.
 * - up to `limit` rows: every row stays as it is
 * - otherwise: group by IBAN and merge rows whose text is ≥ 50 % identical
 *   (one representative row per payee, summing amount and count)
 * - still more than `limit` rows: keep the `limit` most frequent ones
 */
export function simplifyTxs(txs: Tx[], limit = AI_LINE_LIMIT): PromptLine[] {
  if (txs.length <= limit) return txs.map(asLine);

  const byIban = new Map<string, PromptLine[]>();
  for (const t of txs) {
    const key = t.iban || t.account || '?';
    let reps = byIban.get(key);
    if (!reps) {
      reps = [];
      byIban.set(key, reps);
    }
    const cand = asLine(t);
    const hit = reps.find((r) => similarity(r.text, cand.text) >= SIMILAR_MERGE_AT);
    if (hit) {
      hit.count++;
      hit.credit += cand.credit;
      hit.debit += cand.debit;
    } else {
      reps.push(cand);
    }
  }

  const out = Array.from(byIban.values()).flat();
  out.sort((a, b) => b.count - a.count || b.credit + b.debit - (a.credit + a.debit) || a.text.localeCompare(b.text));
  return out.slice(0, limit);
}

/** the transaction block of the prompt — one line per (grouped) row */
export function renderLines(lines: PromptLine[]): string {
  const nf = (n: number): string => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return lines
    .map((l) => {
      const sum = l.credit > 0 ? `+${nf(l.credit)}` : `-${nf(l.debit)}`;
      const times = l.count > 1 ? `${l.count}x ` : '';
      return `- ${times}${sum} | ${l.iban} | ${l.text}`;
    })
    .join('\n');
}

/** existing categories as an indented outline, so the AI extends instead of replacing */
export function renderExisting(settings: Settings): string {
  const kidsOf = (tag: string): string[] => settings.categories.filter((c) => c.tagFather === tag).map((c) => c.tag);
  const roots = settings.categories.filter((c) => !c.tagFather || !settings.categories.some((x) => x.tag === c.tagFather));
  const ruleText = (tag: string): string => {
    const c = settings.categories.find((x) => x.tag === tag);
    if (!c) return '';
    const words = c.rules.map((r) => r.text).join(', ');
    const ibans = c.ibans.length > 0 ? `${words ? ' + ' : ''}iban: ${c.ibans.join(', ')}` : '';
    return words + ibans;
  };
  const out: string[] = [];
  for (const r of roots) {
    const own = ruleText(r.tag);
    const root = settings.categories.find((c) => c.tag === r.tag);
    out.push(`${r.tag}${own ? `: ${own}` : ''}${root?.cashMovement ? ` [cash ${root.cashMovement}]` : ''}`);
    for (const k of kidsOf(r.tag)) {
      const kr = ruleText(k);
      const child = settings.categories.find((c) => c.tag === k);
      out.push(`  - ${k}${kr ? `: ${kr}` : ''}${child?.cashMovement ? ` [cash ${child.cashMovement}]` : ''}`);
    }
  }
  return out.join('\n');
}

/**
 * The full instruction for the AI. `lines` = transactions to include, or
 * null when the user chose not to send any data.
 */
export function buildAiPrompt(settings: Settings, lines: PromptLine[] | null): string {
  const existing = settings.categories.length > 0 ? renderExisting(settings) : '';
  const parts = [
    'You are helping me categorize my bank transactions.',
    '',
    'Write me a category-settings file for the "Transaction Viewer" app in exactly the JSON format below.',
    '',
    '{',
    '  "name": "my-categories",',
    '  "categories": [',
    '    { "tag": "Housing", "color": "#4f7df9", "iban": [], "search_tag": [] },',
    '    { "tag": "Rent", "tag_father": "Housing", "color": "#719cfb", "iban": [], "search_tag": ["rent", "miete"] }',
    '  ]',
    '}',
    '',
    'Format rules:',
    '- "tag": category name in English, unique, short (one or two words).',
    '- "tag_father": optional name of the parent category; leave it out for top-level categories.',
    '- Optional "cash_movement": "withdrawal" or "deposit" only for categories that identify cash transfers; preserve any such marker shown in my current categories.',
    '- "color": hex colour. Top-level categories get clearly different colours, sub-categories a lighter shade of their parent.',
    '- "iban": array of IBANs this category is limited to; use [] for "any account".',
    '- "search_tag": array of lowercase words that appear in the booking text. Matching is a case-insensitive "the text contains this word" test. Use the payee word only - never dates, amounts or card numbers.',
    '- Rows are checked in order and the FIRST category that matches wins, so put specific payees before general words.',
    '- A category that only groups other categories (a parent) gets an empty "search_tag".',
    '',
    'Content rules:',
    '- 12-25 top-level categories, each with 0-4 sub-categories. Every sub-category must have at least one search_tag.',
    '- Only use words that actually occur in the transactions I give you (or in my current categories). Do not invent payees.',
    '- Group repeated payees into one category; keep essentials (Housing, Insurance, Groceries, Dining Out, Transport, Health, Shopping, Online Shopping, Subscriptions, Income, Taxes & Authorities, Bank Fees, Cash & Transfers, Uncategorized is created by the app itself - do not add it).',
    '- Return ONLY the JSON. No prose, no markdown fences, no comments.',
  ];
  if (existing) {
    parts.push(
      '',
      'My current categories (keep the useful ones, improve names, add what is missing):',
      existing,
    );
  }
  if (lines && lines.length > 0) {
    parts.push(
      '',
      `My transactions - ${lines.length} line${lines.length === 1 ? '' : 's'}, each "count x signed total | IBAN | booking text":`,
      renderLines(lines),
    );
  }
  parts.push('', 'Return only the JSON.');
  return parts.join('\n');
}
