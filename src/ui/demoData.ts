import { addUploads, state } from '../state';
import { ABS_MAPPER } from '../csv/schemas';
import { DEMO_FILE_NAME, demoCsv } from '../seed/demoCsv';
import { configureDemoCashCategories, mergeDemoCashEntries } from '../seed/demoCash';
import { listCashEntries, replaceCashEntries } from '../storage/files';
import { putSettingsObj } from '../storage/settings';

/**
 * One-click sample data: generates the anonymized demo statement and matching
 * manual cash entries. Re-loading replaces both demo datasets while preserving
 * the user's own cash entries; removing the demo statement removes its cash rows.
 */
export async function loadDemoData(): Promise<void> {
  if (state.activeSettingsName === 'default' && configureDemoCashCategories(state.settings)) {
    putSettingsObj(state.settings);
  }
  const cashEntries = await listCashEntries();
  await replaceCashEntries(mergeDemoCashEntries(cashEntries));
  state.cashEntries = await listCashEntries();
  await addUploads([{ name: DEMO_FILE_NAME, content: demoCsv(), mapper: ABS_MAPPER }]);
}
