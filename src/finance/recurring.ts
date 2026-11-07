import type { Tx } from '../types';
import type { Cadence, SeriesDecision } from './model';
import { minor } from './model';
import { bankAccountKey } from '../bankBalances';

const DAY = 86400000;
const cadenceDays: Record<Cadence, number> = { weekly: 7, fortnightly: 14, monthly: 30.4375, quarterly: 91.3125, annual: 365.25 };
export const monthlyFactor: Record<Cadence, number> = { weekly: 52 / 12, fortnightly: 26 / 12, monthly: 1, quarterly: 1 / 3, annual: 1 / 12 };
export const CADENCES = Object.keys(cadenceDays) as Cadence[];
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function merchantName(text: string): string {
  return text.toLowerCase().normalize('NFKC').replace(/\b\d{1,4}[-./]\d{1,2}(?:[-./]\d{1,4})?\b/g, ' ')
    .replace(/\b(?:january|february|march|april|may|june|july|august|september|october|november|december|januar|februar|märz|mai|juni|juli|oktober|dezember)\b/g, ' ')
    .replace(/\b\d+[\d.,]*\b/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}
export function recurringKey(tx: Tx): string {
  return JSON.stringify([tx.cashEntryId ? 'cash' : bankAccountKey(tx), tx.debit > 0 ? 'out' : 'in', merchantName(tx.text)]);
}
export function nextDate(date: string, cadence: Cadence, anchorDay?: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(d.getTime())) return '';
  if (cadence === 'weekly' || cadence === 'fortnightly') d.setUTCDate(d.getUTCDate() + (cadence === 'weekly' ? 7 : 14));
  else {
    const day = anchorDay ?? d.getUTCDate();
    const months = cadence === 'monthly' ? 1 : cadence === 'quarterly' ? 3 : 12;
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + months);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  }
  return d.toISOString().slice(0, 10);
}

export interface RecurringSeries {
  id: string; keys: string[]; name: string; rows: Tx[]; cadence: Cadence; variable: boolean;
  confidence: 'low' | 'medium' | 'high'; reason: string; status: 'candidate' | SeriesDecision['status'];
  usual: number; min: number; max: number; monthly: number; next: string; change: number | null; outgoing: boolean;
}

function summarize(rows: Tx[], cadence: Cadence, variableOverride?: boolean): Pick<RecurringSeries, 'variable' | 'usual' | 'min' | 'max' | 'monthly' | 'next' | 'change' | 'outgoing'> {
  const amounts = rows.map((r) => minor(r.debit + r.credit));
  const typical = median(amounts), prior = amounts.slice(0, -1), baseline = prior.length ? median(prior) : typical;
  const tolerance = Math.max(100, baseline * 0.03);
  const priorStable = prior.length >= 2 && prior.every((a) => Math.abs(a - baseline) <= tolerance);
  const variable = variableOverride ?? !(amounts.every((a) => Math.abs(a - typical) <= Math.max(100, typical * 0.05)) || priorStable);
  const change = !variable && priorStable && Math.abs(amounts.at(-1)! - baseline) > tolerance ? (amounts.at(-1)! - baseline) / 100 : null;
  // Use latest price for fixed commitments; median observed bill for variable ones.
  const usual = (variable ? typical : amounts.at(-1)!) / 100;
  const anchor = Math.max(...rows.map((r) => new Date(`${r.bookingDate}T00:00:00Z`).getUTCDate()));
  return { variable, usual, min: Math.min(...amounts) / 100, max: Math.max(...amounts) / 100,
    monthly: usual * monthlyFactor[cadence], next: nextDate(rows.at(-1)!.bookingDate, cadence, anchor), change, outgoing: rows[0].debit > 0 };
}

function inferCadence(rows: Tx[]): { cadence: Cadence; reason: string; confidence: RecurringSeries['confidence'] } | null {
  const dates = rows.map((r) => Date.parse(r.bookingDate));
  const gaps = dates.slice(1).map((d, i) => (d - dates[i]) / DAY);
  if (gaps.some((g) => g < 3 || !Number.isFinite(g))) return null;
  const choices = CADENCES.flatMap((cadence) => {
    if (rows.length < 3 && cadence !== 'annual' && cadence !== 'quarterly') return [];
    const tolerance = cadence === 'weekly' ? 2 : cadence === 'fortnightly' ? 3 : cadence === 'monthly' ? 5 : cadence === 'quarterly' ? 8 : 12;
    const errors = gaps.map((_, i) => {
      const expected = nextDate(rows[i].bookingDate, cadence);
      return Math.abs(dates[i + 1] - Date.parse(expected)) / DAY;
    });
    if (!errors.every((e) => e <= tolerance)) return [];
    return [{ cadence, score: errors.reduce((s, e) => s + e / tolerance, 0) / errors.length }];
  }).sort((a, b) => a.score - b.score);
  if (!choices.length) return null;
  const { cadence, score } = choices[0];
  return { cadence, confidence: rows.length === 2 ? 'low' : score < 0.4 && rows.length >= 4 ? 'high' : 'medium',
    reason: `${rows.length} observed payments · calendar-aware ${cadence} intervals · ${rows[0].bookingDate} to ${rows.at(-1)!.bookingDate}` };
}

/** Deterministic grouping, O(n log n); decisions own rows before automatic candidates. */
export function detectRecurring(input: Tx[], decisions: SeriesDecision[] = []): RecurringSeries[] {
  const rows = [...new Map(input.filter((r) => !r.internalTransfer && !r.cashAdjustment && (r.debit > 0) !== (r.credit > 0)
    && /^\d{4}-\d{2}-\d{2}$/.test(r.bookingDate) && Number.isFinite(Date.parse(r.bookingDate))).map((r) => [r.id, r])).values()]
    .sort((a, b) => a.bookingDate.localeCompare(b.bookingDate) || a.id.localeCompare(b.id));
  const claimed = new Set<string>();
  const result: RecurringSeries[] = [];
  for (const decision of decisions) {
    const ids = new Set(decision.txIds), keys = new Set(decision.keys);
    const members = rows.filter((r) => !claimed.has(r.id) && (ids.has(r.id) || (decision.status !== 'ended' && keys.has(recurringKey(r)))));
    members.forEach((r) => claimed.add(r.id));
    if (!members.length) continue;
    result.push({ ...decision, rows: members, ...summarize(members, decision.cadence, decision.variable), confidence: members.length < 3 ? 'low' : 'medium', reason: 'User-reviewed series; confidence describes the available observations, not certainty about future payments.' });
  }
  const groups = new Map<string, Tx[]>();
  for (const row of rows) {
    if (claimed.has(row.id) || merchantName(row.text).length < 3) continue;
    const key = recurringKey(row), group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
  }
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const inferred = inferCadence(group);
    if (!inferred) continue;
    if (group.length === 2) {
      const amounts = group.map((r) => minor(r.debit + r.credit));
      const similar = Math.abs(amounts[0] - amounts[1]) <= Math.max(100, amounts[0] * 0.05);
      const billHint = /subscription|membership|premium|insurance|utility|direct debit|annual|quarterly|renewal/i.test(group[0].text);
      if (!similar && !billHint) continue;
    }
    result.push({ id: `auto:${key}`, keys: [key], rows: group, name: merchantName(group[0].text), status: 'candidate',
      ...inferred, ...summarize(group, inferred.cadence) });
  }
  return result;
}
