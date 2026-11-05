import { Database, Download, FileUp, TriangleAlert, X } from 'lucide';
import { BACKUP_SCHEMA_VERSION, createBackup, parseBackup, restoreBackup, type AppBackup } from '../storage/backup';
import { state } from '../state';
import { C, cx, downloadText, h, toast } from './util';
import { Ic } from './icons';
import { importJsonFile } from './importJson';

let overlay: HTMLElement | null = null;

function closeModal(): void {
  overlay?.remove();
  overlay = null;
  document.removeEventListener('keydown', onEsc);
}

function onEsc(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeModal();
}

function fileDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

async function downloadBackup(): Promise<void> {
  try {
    const backup = await createBackup();
    downloadText(`transaction-viewer-backup-${fileDate()}.json`, JSON.stringify(backup, null, 2));
    toast(`Backup exported (${backup.data.csvFiles.length} CSV files)`);
  } catch (error) {
    toast(`Backup export failed: ${String(error)}`, 'err');
  }
}

export function openDbModal(): void {
  closeModal();
  const picker = h('input', { attrs: { type: 'file', accept: '.json,application/json', class: 'hidden' } }) as HTMLInputElement;
  picker.addEventListener('change', async () => {
    const file = picker.files?.[0];
    closeModal();
    if (file) await importJsonFile(file);
    picker.value = '';
  });

  const card = h('div', { class: 'max-h-[88vh] w-full max-w-[560px] overflow-y-auto border border-border bg-card p-4 shadow-card' },
    h('div', { class: 'mb-2 flex items-center gap-2' },
      h('h3', { class: 'flex items-center gap-2 text-[15px] font-semibold' }, Ic(Database, 'size-4'), 'Database backup'),
      h('button', { class: cx(C.btn, 'ml-auto px-2 py-1'), onclick: closeModal, title: 'Close (Esc)' }, Ic(X, 'size-3.5'))),
    h('p', { class: cx(C.muted, 'mb-3 text-[12.5px]') },
      'Export a complete backup of your transactions, CSV files, categories, settings, schemas, and saved preferences. Backups stay on your device; the JSON file contains sensitive financial data.'),
    h('div', { class: 'mb-4 grid grid-cols-2 gap-x-4 gap-y-1 bg-muted/40 p-3 text-[12px] sm:grid-cols-4' },
      h('span', { class: C.muted, text: 'Transactions' }), h('strong', { text: state.txs.length.toLocaleString() }),
      h('span', { class: C.muted, text: 'CSV files' }), h('strong', { text: state.loaded.length.toLocaleString() }),
      h('span', { class: C.muted, text: 'Categories' }), h('strong', { text: state.settings.categories.length.toLocaleString() }),
      h('span', { class: C.muted, text: 'Settings bundles' }), h('strong', { text: state.settingsFiles.length.toLocaleString() })),
    h('div', { class: 'flex flex-wrap gap-2' },
      h('button', { class: C.btnPrimary, onclick: () => void downloadBackup() }, Ic(Download, 'size-3.5'), 'Export full backup'),
      h('button', { class: C.btn, onclick: () => picker.click() }, Ic(FileUp, 'size-3.5'), 'Restore backup…'),
      h('span', { class: cx(C.muted, 'basis-full pt-1 text-[11px]'), text: `Backup format version ${BACKUP_SCHEMA_VERSION}. Restore replaces current data; it does not merge.` })),
  );
  overlay = h('div', {
    class: 'fixed inset-0 z-[110] grid place-items-center bg-black/45 p-3 backdrop-blur-[2px]',
    onclick: (event: MouseEvent) => { if (event.target === overlay) closeModal(); },
  }, card);
  document.body.append(overlay);
  document.addEventListener('keydown', onEsc);
}

/** Ask before replacing data; resolving only after the user chooses keeps drag/drop sequential. */
export function openBackupRestoreModal(fileName: string, input: unknown): Promise<boolean> {
  let backup: AppBackup;
  try {
    backup = parseBackup(input);
  } catch (error) {
    toast(`${fileName}: ${(error as Error).message}`, 'err');
    return Promise.resolve(false);
  }
  closeModal();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (restored: boolean): void => {
      if (settled) return;
      settled = true;
      closeModal();
      resolve(restored);
    };
    const restoreBtn = h('button', { class: C.btnDanger, onclick: async () => {
      restoreBtn.disabled = true;
      restoreBtn.textContent = 'Restoring…';
      try {
        await restoreBackup(backup);
        finish(true);
        location.reload();
      } catch (error) {
        restoreBtn.disabled = false;
        restoreBtn.textContent = 'Replace all data';
        toast((error as Error).message, 'err');
      }
    } }, 'Replace all data');
    const card = h('div', { class: 'max-h-[88vh] w-full max-w-[560px] overflow-y-auto border border-border bg-card p-4 shadow-card' },
      h('div', { class: 'mb-2 flex items-center gap-2' },
        h('h3', { class: 'flex items-center gap-2 text-[15px] font-semibold' }, Ic(TriangleAlert, 'size-4'), 'Replace current database?'),
        h('button', { class: cx(C.btn, 'ml-auto px-2 py-1'), onclick: () => finish(false), title: 'Close (Esc)' }, Ic(X, 'size-3.5'))),
      h('p', { class: 'mb-3 text-sm' }, 'Restoring this backup replaces all current transactions, CSV files, categories, settings, schemas, and saved preferences. Data will not be merged.'),
      h('p', { class: cx(C.muted, 'mb-3 text-[12px]') }, `Backup: ${fileName} · ${backup.data.csvFiles.length} CSV files${backup.exportedAt ? ` · exported ${new Date(backup.exportedAt).toLocaleString()}` : ''}`),
      h('div', { class: 'mb-4 flex items-start gap-2 bg-warning/10 p-3 text-[12px] text-warning' }, Ic(TriangleAlert, 'mt-0.5 size-4 shrink-0'), 'If you need the current data, cancel and export a backup first.'),
      h('div', { class: 'flex flex-wrap items-center gap-2' },
        restoreBtn,
        h('button', { class: cx(C.btn, 'ml-auto'), onclick: () => finish(false) }, 'Cancel')),
    );
    overlay = h('div', {
      class: 'fixed inset-0 z-[110] grid place-items-center bg-black/45 p-3 backdrop-blur-[2px]',
      onclick: (event: MouseEvent) => { if (event.target === overlay) finish(false); },
    }, card);
    document.body.append(overlay);
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') finish(false); }, { once: true });
  });
}
