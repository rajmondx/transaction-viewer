import { downloadText } from './util';

/**
 * Shared helpers for exporting on-screen tables as CSV files.
 * The two table tabs (csv.ts, spending.ts) hand their rows over; both exports
 * mirror the display: same columns, same order, all rows currently in the table.
 *
 * The header's export button is generic, exactly like the print button: the
 * active table tab registers the function that opens its export dialog here
 * (main.ts clears it before each render, so tabs without a table leave the
 * button disabled).
 */
let tabExportHandler: (() => void) | null = null;

export function setTabExportHandler(fn: (() => void) | null): void {
  tabExportHandler = fn;
}

export function hasTabExportHandler(): boolean {
  return tabExportHandler !== null;
}

export function triggerTabExport(): void {
  tabExportHandler?.();
}

/** RFC-4180: quote only when the value contains the delimiter, a quote or a line break. */
export function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Table rows as CSV text — comma-separated CRLF lines (exactly what parseCsvRecords reads back). */
export function buildCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Download as .csv; the BOM makes Excel read umlauts and € from the UTF-8 file correctly. */
export function downloadCsv(filename: string, rows: string[][]): void {
  downloadText(filename, '\ufeff' + buildCsv(rows), 'text/csv;charset=utf-8');
}

/**
 * Amount the way a spreadsheet wants it: `1234.50` / `-1234.50` — a dot for the
 * decimals, no thousands groups, plain ASCII minus (the tables display `'` groups
 * and a typographic −; the export carries the same numbers, just machine-readable).
 */
export function exportAmount(v: number): string {
  const s = v.toFixed(2);
  return s === '-0.00' ? '0.00' : s;
}

/** Today as yyyy-mm-dd, to name exported files. */
export function fileStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
