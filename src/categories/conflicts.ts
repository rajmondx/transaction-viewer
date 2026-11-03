import type { Category, SearchRule, Settings, Tx } from '../types';
import { UNCAT, ruleMatches, txMatchesCategory } from './engine';

/**
 * Conflict audit for the category editor.
 *
 * Matching itself is unchanged — the first category in file order still wins
 * (see engine.matchTx). What this adds is visibility: because a transaction can
 * only ever land in ONE category, every overlapping rule silently takes rows
 * away from the categories below it. The editor would otherwise only show the
 * winner's count, so a fully shadowed category looks broken instead of
 * conflicting.
 *
 * Two kinds of findings:
 *   - measured (need transactions loaded): how many rows a category WOULD match
 *     by its own rules vs. how many it actually wins, and who took the rest.
 *     This is what catches the cases string comparison cannot — `rent` vs
 *     `miete`, a parent with its own rules eating its children, an IBAN-only
 *     parent swallowing a whole account.
 *   - static (work with nothing loaded, so they also help a freshly AI-written
 *     bundle): the exact same rule in a lower-priority category can never add a
 *     match, the same `tag` twice, an empty search text that matches everything.
 *
 * `decide`, `explainTx` and `undecidedRows` at the bottom answer the follow-up
 * question for a single row — which rule actually decided it and which ones were
 * overruled. They run on demand (one click in the editor), never per render.
 */

/** sums of the transactions actually assigned to one tag */
export interface Sum {
  count: number;
  debit: number;
  credit: number;
}

/** one higher-priority category that took rows this category would also match */
export interface Shadow {
  catIndex: number;
  tag: string;
  count: number;
}

/** per-category result of running the loaded transactions through the rules */
export interface CategoryAudit {
  catIndex: number;
  tag: string;
  /** rows satisfying this category's OWN rules, ignoring priority */
  wouldMatch: number;
  /** rows that actually end up here (first match wins) */
  won: number;
  debit: number;
  credit: number;
  /** rows lost to higher priority categories, biggest taker first */
  shadowedBy: Shadow[];
}

export interface ConflictReport {
  /** one entry per category, same order as settings.categories */
  audits: CategoryAudit[];
  /** assignments per winning tag, `Uncategorized` included */
  preview: Map<string, Sum>;
  /** per category, per rule: index of the first category carrying that exact
   *  rule (itself when the copy is within the same category), -1 when unique */
  ruleOwner: number[][];
  /** tags used by more than one category — the tree and the badges key by tag,
   *  so duplicates merge into one bucket */
  duplicateTags: Array<{ tag: string; indexes: number[] }>;
  /** categories holding an empty search text, which matches every transaction */
  matchAll: number[];
}

/** an exact duplicate only when text AND flags agree — `miete` and `miete.*`
 *  (regex) are different rules, not a redundant copy. Case does not matter for
 *  a rule matched case-insensitively (ruleMatches lowercases both sides), so
 *  "PayPal" and "paypal" ARE the same rule unless one of them is case-sensitive. */
function ruleKey(r: SearchRule): string {
  const text = r.caseSensitive ? r.text : r.text.toLowerCase();
  return `${text}\u0000${r.caseSensitive ? 1 : 0}\u0000${r.fuzzy ? 1 : 0}\u0000${r.regex ? 1 : 0}`;
}

/** rows this category loses to a higher priority one */
export function hiddenRows(a: CategoryAudit): number {
  return a.wouldMatch - a.won;
}

/** every row it would match is taken by someone else, so it stays empty */
export function isDead(a: CategoryAudit): boolean {
  return a.wouldMatch > 0 && a.won === 0;
}

export function auditSettings(settings: Settings, txs: Tx[]): ConflictReport {
  const cats = settings.categories;
  const audits: CategoryAudit[] = cats.map((c, i) => ({
    catIndex: i,
    tag: c.tag,
    wouldMatch: 0,
    won: 0,
    debit: 0,
    credit: 0,
    shadowedBy: [],
  }));
  const takers = cats.map(() => new Map<number, number>());

  const preview = new Map<string, Sum>();
  const add = (tag: string, tx: Tx): void => {
    const s = preview.get(tag) ?? { count: 0, debit: 0, credit: 0 };
    s.count++;
    s.debit += tx.debit;
    s.credit += tx.credit;
    preview.set(tag, s);
  };

  // one pass: collect EVERY category a row matches, not just the winner, so the
  // cost stays what computePreview already paid (categories × transactions)
  for (const tx of txs) {
    let win = -1;
    for (let i = 0; i < cats.length; i++) {
      if (!txMatchesCategory(tx, cats[i])) continue; // disabled / wrong IBAN / no match
      audits[i].wouldMatch++;
      if (win < 0) {
        win = i;
        audits[i].won++;
        audits[i].debit += tx.debit;
        audits[i].credit += tx.credit;
        add(audits[i].tag, tx);
      } else {
        takers[i].set(win, (takers[i].get(win) ?? 0) + 1);
      }
    }
    if (win < 0) add(UNCAT, tx);
  }
  audits.forEach((a, i) => {
    a.shadowedBy = Array.from(takers[i].entries())
      .map(([catIndex, count]) => ({ catIndex, count, tag: cats[catIndex].tag }))
      .sort((x, y) => y.count - x.count || x.catIndex - y.catIndex);
  });

  // ---- static checks (no transactions needed) ----
  const firstSeen = new Map<string, number>();
  const ruleOwner: number[][] = [];
  const matchAll: number[] = [];
  cats.forEach((c, i) => {
    const row: number[] = [];
    for (const r of c.rules) {
      const seen = firstSeen.get(ruleKey(r));
      if (seen === undefined) {
        firstSeen.set(ruleKey(r), i);
        row.push(-1);
      } else {
        row.push(seen);
      }
    }
    ruleOwner.push(row);
    if (c.rules.some((r) => r.text === '')) matchAll.push(i);
  });

  const tagIndexes = new Map<string, number[]>();
  cats.forEach((c, i) => {
    const list = tagIndexes.get(c.tag) ?? [];
    list.push(i);
    tagIndexes.set(c.tag, list);
  });

  return {
    audits,
    preview,
    ruleOwner,
    duplicateTags: Array.from(tagIndexes.entries())
      .filter(([, indexes]) => indexes.length > 1)
      .map(([tag, indexes]) => ({ tag, indexes })),
    matchAll,
  };
}

// ---------- one row, explained ----------

/** the one rule that decides a row: first hit inside the first matching category */
export interface Decision {
  catIndex: number;
  /** which rule decided it; -1 when the category has no rules and matched on its IBAN list */
  ruleIndex: number;
}

/** the same decision matchTx makes, resolved down to the rule */
export function decide(settings: Settings, tx: Tx): Decision | null {
  const cats = settings.categories;
  for (let i = 0; i < cats.length; i++) {
    if (!txMatchesCategory(tx, cats[i])) continue;
    return { catIndex: i, ruleIndex: cats[i].rules.findIndex((r) => ruleMatches(r, tx.hay)) };
  }
  return null;
}

/** one category claiming a row */
export interface Claimant {
  catIndex: number;
  tag: string;
  /** the first claimant wins — the list is in priority order */
  wins: boolean;
  /** its rules that hit this row; empty when it matched on its IBAN list only */
  rules: number[];
}

/** every category and rule claiming this row, in priority order */
export function explainTx(settings: Settings, tx: Tx): Claimant[] {
  const out: Claimant[] = [];
  settings.categories.forEach((c, i) => {
    if (!txMatchesCategory(tx, c)) return;
    const rules: number[] = [];
    c.rules.forEach((r, ri) => {
      if (ruleMatches(r, tx.hay)) rules.push(ri);
    });
    out.push({ catIndex: i, tag: c.tag, wins: out.length === 0, rules });
  });
  return out;
}

/**
 * Rows where a category — or one rule of it — matches yet does not decide the
 * row: either a category above takes it, or another rule of the same category
 * already decided it. Both conflict kinds the editor flags end up in one list
 * this way, so the panel needs only one view.
 */
export function undecidedRows(settings: Settings, txs: Tx[], catIndex: number, ruleIndex: number | null): Tx[] {
  const c: Category | undefined = settings.categories[catIndex];
  if (!c) return [];
  const rule = ruleIndex == null ? null : c.rules[ruleIndex];
  if (ruleIndex != null && !rule) return [];
  const out: Tx[] = [];
  for (const tx of txs) {
    if (rule ? !ruleMatches(rule, tx.hay) : !txMatchesCategory(tx, c)) continue;
    const d = decide(settings, tx);
    if (!d || (d.catIndex === catIndex && (ruleIndex == null || d.ruleIndex === ruleIndex))) continue;
    out.push(tx);
  }
  return out;
}
