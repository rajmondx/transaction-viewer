import type { Agg, Category, Month, SearchRule, Settings, Tx } from '../types';
import { monthKey } from '../ui/util';

export const UNCAT = 'Uncategorized';

/** fuzzy: query chars appear in order (subsequence) */
export function fuzzyIn(hay: string, needle: string): boolean {
  if (needle === '') return true;
  let q = 0;
  for (let i = 0; i < hay.length && q < needle.length; i++) {
    if (hay[i] === needle[q]) q++;
  }
  return q === needle.length;
}

const regexCache = new Map<string, RegExp | null>();
function compileRegex(pattern: string, caseSensitive: boolean): RegExp | null {
  const key = `${caseSensitive ? 's' : 'i'}:${pattern}`;
  if (regexCache.has(key)) return regexCache.get(key) ?? null;
  let re: RegExp | null = null;
  try {
    re = new RegExp(pattern, caseSensitive ? '' : 'i');
  } catch {
    re = null;
  }
  regexCache.set(key, re);
  return re;
}

export function ruleMatches(rule: SearchRule, hay: string): boolean {
  if (rule.text === '') return true;
  if (rule.regex) {
    const re = compileRegex(rule.text, rule.caseSensitive);
    return re ? re.test(hay) : false;
  }
  const n = rule.caseSensitive ? rule.text : rule.text.toLowerCase();
  const h = rule.caseSensitive ? hay : hay.toLowerCase();
  return rule.fuzzy ? fuzzyIn(h, n) : h.includes(n);
}

/** Does this transaction satisfy a category's full rule set? */
export function txMatchesCategory(tx: Tx, c: Category): boolean {
  if (!c.enabled) return false;
  if (c.ibans.length > 0 && !c.ibans.includes(tx.iban)) return false;
  if (c.rules.length > 0 && !c.rules.some((r) => ruleMatches(r, tx.hay))) return false;
  if (c.ibans.length === 0 && c.rules.length === 0) return false; // empty category matches nothing
  if (c.dateFrom && tx.bookingDate && tx.bookingDate < c.dateFrom) return false;
  if (c.dateTo && tx.bookingDate && tx.bookingDate > c.dateTo) return false;
  return true;
}

/** First matching category wins (order = priority). Returns tag or UNCAT. */
export function matchTx(tx: Tx, settings: Settings): string {
  const override = tx.categoryOverrides?.[settings.name];
  if (override) return settings.categories.some((c) => c.tag === override) ? override : UNCAT;
  if (tx.manualCategory) return settings.categories.some((c) => c.tag === tx.manualCategory) ? tx.manualCategory : UNCAT;
  for (const c of settings.categories) {
    if (txMatchesCategory(tx, c)) return c.tag;
  }
  return UNCAT;
}

export interface TreeNode {
  tag: string;
  category: Category | null; // null for the pseudo Uncategorized node
  children: TreeNode[];
  depth: number;
}

/** Build the category forest. Uncategorized is appended as a synthetic root. */
export function buildTree(settings: Settings): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  settings.categories.forEach((c) => {
    if (!nodes.has(c.tag)) nodes.set(c.tag, { tag: c.tag, category: c, children: [], depth: 0 });
  });
  const roots: TreeNode[] = [];
  for (const tag of Array.from(nodes.keys())) {
    const node = nodes.get(tag)!;
    let f = node.category?.tagFather ?? null;
    const seen = new Set<string>([tag]);
    while (f && (!nodes.has(f) || seen.has(f))) f = nodes.get(f)?.category?.tagFather ?? null;
    if (f) nodes.get(f)!.children.push(node);
    else roots.push(node);
  }
  // detect cycles: nodes not reachable from any root become roots
  const reachable = new Set<string>();
  const mark = (n: TreeNode) => {
    if (reachable.has(n.tag)) return;
    reachable.add(n.tag);
    n.children.forEach(mark);
  };
  roots.forEach(mark);
  for (const [tag, node] of nodes) {
    if (!reachable.has(tag)) {
      node.children = [];
      roots.push(node);
    }
  }
  const unc: TreeNode = { tag: UNCAT, category: null, children: [], depth: 0 };
  roots.push(unc);
  const setDepth = (n: TreeNode, d: number) => {
    n.depth = d;
    n.children.forEach((ch) => setDepth(ch, d + 1));
  };
  roots.forEach((r) => setDepth(r, 0));
  return roots;
}

/** flatten tree into pre-order list */
export function flattenTree(roots: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (n: TreeNode) => {
    out.push(n);
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  return out;
}

export interface Aggregation {
  /** own (directly assigned) sums per tag per month */
  own: Map<string, Map<Month, Agg>>;
  /** subtree sums per tag (parents include children) */
  subtree: Map<string, { debit: number; credit: number; count: number }>;
  /** transactions per tag (own assignments) */
  txByTag: Map<string, Tx[]>;
  months: Month[];
  totals: { debit: number; credit: number; count: number };
}

const emptyAgg = (): Agg => ({ debit: 0, credit: 0, count: 0 });

export function aggregate(txs: Tx[], settings: Settings): Aggregation {
  const own = new Map<string, Map<Month, Agg>>();
  const txByTag = new Map<string, Tx[]>();
  const monthsSet = new Set<Month>();
  const ownIds = new Map<string, Set<string>>();
  const totalIds = new Set<string>();
  for (const tx of txs) {
    const tag = matchTx(tx, settings);
    const month = monthKey(tx.bookingDate || tx.valueDate);
    monthsSet.add(month);
    if (!own.has(tag)) own.set(tag, new Map());
    const byMonth = own.get(tag)!;
    if (!byMonth.has(month)) byMonth.set(month, emptyAgg());
    const a = byMonth.get(month)!;
    a.debit += tx.debit;
    a.credit += tx.credit;
    const origin = tx.parentId ?? tx.id;
    const countKey = JSON.stringify([tag, month]);
    const ids = ownIds.get(countKey) ?? new Set<string>();
    ids.add(origin); ownIds.set(countKey, ids); a.count = ids.size;
    totalIds.add(origin);
    if (!txByTag.has(tag)) txByTag.set(tag, []);
    txByTag.get(tag)!.push(tx);
  }
  const months = Array.from(monthsSet).sort();
  const tree = buildTree(settings);
  const subtree = new Map<string, { debit: number; credit: number; count: number }>();
  const subtreeIds = new Map<string, Set<string>>();
  const roll = (n: TreeNode): { debit: number; credit: number; count: number } => {
    let d = 0, c = 0, k = 0;
    const ids = new Set((txByTag.get(n.tag) ?? []).map((t) => t.parentId ?? t.id));
    for (const ch of n.children) {
      const r = roll(ch);
      d += r.debit; c += r.credit; k += r.count;
      for (const id of subtreeIds.get(ch.tag) ?? []) ids.add(id);
    }
    const ownM = own.get(n.tag);
    if (ownM) for (const a of ownM.values()) { d += a.debit; c += a.credit; k += a.count; }
    k = ids.size;
    subtreeIds.set(n.tag, ids);
    const val = { debit: d, credit: c, count: k };
    subtree.set(n.tag, val);
    return val;
  };
  tree.forEach(roll);
  let td = 0, tc = 0, tk = 0;
  for (const m of own.values()) {
    for (const a of m.values()) { td += a.debit; tc += a.credit; tk += a.count; }
  }
  tk = totalIds.size;
  return { own, subtree, txByTag, months, totals: { debit: td, credit: tc, count: tk } };
}

/** all months present in the transactions, sorted */
export function monthsFromTxs(txs: Tx[]): Month[] {
  const s = new Set<Month>();
  for (const t of txs) s.add(monthKey(t.bookingDate || t.valueDate));
  return Array.from(s).sort();
}
