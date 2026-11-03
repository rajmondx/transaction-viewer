import type { CsvFileInfo, Mapper, Tx } from '../types';
import { parseWithMapper } from './parse';

/**
 * Dedup rules for overlapping bank exports (same transaction re-listed in
 * several files). Keys collide only when transaction ID + IBAN + amounts are
 * equal (see csv/parse.ts makeTxId), so the difference is in text or date:
 *   - longer description wins
 *   - newer booking date wins (value date likewise)
 * The two rules apply independently, regardless of which file each came from.
 */
export function mergeInto(existing: Tx, incoming: Tx): void {
  if (incoming.text.length > existing.text.length) {
    existing.text = incoming.text;
    existing.hay = incoming.hay;
  }
  if (incoming.bookingDate > existing.bookingDate) existing.bookingDate = incoming.bookingDate;
  if (incoming.valueDate > existing.valueDate) existing.valueDate = incoming.valueDate;
}

/** Merge txs into the map, returning counts of new / merged-duplicate rows. */
export function dedupIngest(txs: Tx[], byId: Map<string, Tx>): { added: number; dupes: number } {
  let added = 0;
  let dupes = 0;
  for (const tx of txs) {
    const prev = byId.get(tx.id);
    if (prev) {
      mergeInto(prev, tx);
      dupes++;
    } else {
      byId.set(tx.id, tx);
      added++;
    }
  }
  return { added, dupes };
}

export interface IngestInput {
  name: string;
  content: string;
  /** the mapper snapshot stored with the file; null = needs remapping */
  mapper: Mapper | null;
}

export interface IngestResult {
  txs: Tx[];
  files: CsvFileInfo[];
  warnings: string[];
  /** file names that have no usable mapper (skipped from the dataset) */
  needsMapper: string[];
}

/**
 * Parse every stored file with ITS OWN mapper and dedup across all of them
 * (statements from different banks can coexist). Pure — no storage, no UI.
 */
export function ingestFiles(inputs: IngestInput[]): IngestResult {
  const byId = new Map<string, Tx>();
  const warnings: string[] = [];
  const needsMapper: string[] = [];
  const files: CsvFileInfo[] = [];
  for (const f of inputs) {
    if (!f.mapper) {
      needsMapper.push(f.name);
      files.push({ name: f.name, rows: 0, mapper: '' });
      continue;
    }
    const res = parseWithMapper(f.content, f.name, f.mapper);
    if (res.missing.length > 0) {
      needsMapper.push(f.name);
      warnings.push(...res.warnings);
      files.push({ name: f.name, rows: 0, mapper: f.mapper.name });
      continue;
    }
    warnings.push(...res.warnings);
    const { added } = dedupIngest(res.txs, byId);
    files.push({ name: f.name, rows: added, mapper: f.mapper.name });
  }
  const txs = Array.from(byId.values()).sort((a, b) => (b.bookingDate || '').localeCompare(a.bookingDate || ''));
  return { txs, files, warnings, needsMapper };
}
