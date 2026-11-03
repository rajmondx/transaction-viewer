import { state } from '../state';
import { openUploadModal } from './uploadModal';
import { toast } from './util';
import { decodeSmart } from '../csv/parse';

/**
 * Shared upload entry point (header button, drag&drop, CSV tab): decode the
 * files, auto-detect their schema and open the upload modal — nothing is
 * stored until the user confirms the mappings there.
 */
export async function doUpload(files: File[]): Promise<void> {
  const samples: Array<{ name: string; content: string }> = [];
  for (const f of files) {
    samples.push({ name: f.name, content: decodeSmart(await f.arrayBuffer()) });
  }
  openUploadModal(samples, 'upload');
}

/** "Mappers…" on the CSV tab: re-map the stored files' schema snapshots. */
export function openMapperManager(): void {
  if (state.loaded.length === 0) {
    toast('Add a CSV first, then manage schemas');
    return;
  }
  openUploadModal(state.loaded.map((f) => ({ name: f.name, content: f.content, mapper: f.mapper })), 'remap');
}
