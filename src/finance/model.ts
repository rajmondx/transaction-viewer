/** Durable user decisions. Imported transactions are never rewritten. */
export interface SplitPart { amount: number; category: string; note: string }
export interface Annotation { category?: string; parts?: SplitPart[] }
export interface TransferLink { id: string; left: string; right: string }
export type Cadence = 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'annual';
export interface SeriesDecision {
  id: string;
  name: string;
  txIds: string[];
  /** Additional transactions with these detector keys can join this series. */
  keys: string[];
  status: 'confirmed' | 'dismissed' | 'ended';
  cadence: Cadence;
  variable: boolean;
}
export interface Budget { category: string; limit: number; months: Record<string, number> }
export interface FinanceData {
  version: 1;
  bundles: Record<string, { annotations: Record<string, Annotation>; budgets: Budget[] }>;
  transfers: TransferLink[];
  rejectedTransfers: string[];
  series: SeriesDecision[];
}
export const emptyFinance = (): FinanceData => ({ version: 1, bundles: {}, transfers: [], rejectedTransfers: [], series: [] });
export const minor = (amount: number): number => Math.round(amount * 100);

/** Form-editor renames carry explicit references, never inferred from JSON diffs. */
export function renameFinanceCategories(data: FinanceData, bundleName: string, renames: Array<[string, string]>): void {
  const bundle = data.bundles[bundleName];
  if (!bundle) return;
  for (const [oldTag, newTag] of renames) {
    const oldBudget = bundle.budgets.find((b) => b.category === oldTag);
    if (oldBudget && bundle.budgets.some((b) => b !== oldBudget && b.category === newTag)) {
      throw new Error(`Both ${oldTag} and ${newTag} have budgets. Resolve the duplicate budget before renaming.`);
    }
    for (const annotation of Object.values(bundle.annotations)) {
      if (annotation.category === oldTag) annotation.category = newTag;
      for (const part of annotation.parts ?? []) if (part.category === oldTag) part.category = newTag;
    }
    if (oldBudget) oldBudget.category = newTag;
  }
}

/** Strict validation is shared by IndexedDB and backup restore. */
export function parseFinance(value: unknown): FinanceData {
  const fail = (): never => { throw new Error('Invalid finance decisions'); };
  const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');
  const amount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && Number.isSafeInteger(minor(v));
  if (!record(value) || value.version !== 1 || !record(value.bundles) || !Array.isArray(value.transfers)
    || !strings(value.rejectedTransfers) || !Array.isArray(value.series)) return fail();
  for (const bundle of Object.values(value.bundles)) {
    if (!record(bundle) || !record(bundle.annotations) || !Array.isArray(bundle.budgets)) return fail();
    for (const a of Object.values(bundle.annotations)) {
      if (!record(a) || (a.category !== undefined && typeof a.category !== 'string')) return fail();
      if (a.parts !== undefined && (!Array.isArray(a.parts) || a.parts.length < 2 || !a.parts.every((p: unknown) =>
        record(p) && amount(p.amount) && minor(p.amount) > 0 && typeof p.category === 'string' && typeof p.note === 'string'))) return fail();
    }
    for (const b of bundle.budgets) {
      if (!record(b) || typeof b.category !== 'string' || !amount(b.limit) || !record(b.months)
        || !Object.entries(b.months).every(([m, n]) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m) && amount(n))) return fail();
    }
    if (new Set(bundle.budgets.map((b: Budget) => b.category)).size !== bundle.budgets.length) return fail();
  }
  const linked = new Set<string>();
  const ids = new Set<string>();
  for (const t of value.transfers) {
    if (!record(t) || typeof t.id !== 'string' || typeof t.left !== 'string' || typeof t.right !== 'string'
      || t.left === t.right || linked.has(t.left) || linked.has(t.right) || ids.has(t.id)) return fail();
    linked.add(t.left); linked.add(t.right); ids.add(t.id);
  }
  const seriesIds = new Set<string>();
  for (const s of value.series) {
    if (!record(s) || typeof s.id !== 'string' || typeof s.name !== 'string' || !strings(s.txIds) || !strings(s.keys)
      || !['confirmed', 'dismissed', 'ended'].includes(s.status) || typeof s.variable !== 'boolean'
      || !['weekly', 'fortnightly', 'monthly', 'quarterly', 'annual'].includes(s.cadence) || seriesIds.has(s.id)) return fail();
    seriesIds.add(s.id);
  }
  return structuredClone(value) as FinanceData;
}
