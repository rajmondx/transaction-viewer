import { addUploads } from '../state';
import { ABS_MAPPER } from '../csv/schemas';
import { DEMO_FILE_NAME, demoCsv } from '../seed/demoCsv';

/**
 * One-click sample data: generates the anonymized demo statement
 * (src/seed/demoCsv.ts) and runs it through the normal upload path, so it is
 * stored, parsed, categorized and deduplicated exactly like a real CSV.
 * Re-loading replaces the previous demo file (same name), and the CSV page
 * removes it again through its "remove" button.
 */
export async function loadDemoData(): Promise<void> {
  await addUploads([{ name: DEMO_FILE_NAME, content: demoCsv(), mapper: ABS_MAPPER }]);
}
