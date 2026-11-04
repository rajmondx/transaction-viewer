import { Download, FileUp, Landmark, Menu, Moon, Printer, Sun, Upload } from 'lucide';
import { state, bootstrap, subscribe } from './state';
import { doUpload } from './ui/uploadFlow';
import { onCsvPicked } from './ui/addCsv';
import { importJsonFile } from './ui/importJson';
import { renderSpending } from './ui/tabs/spending';
import { renderSettings } from './ui/tabs/settings';
import { toast } from './ui/util';
import { Ic } from './ui/icons';
import { renderCsvTab } from './ui/tabs/csv';
import { renderHelp } from './ui/tabs/help';
import { renderAppFooter } from './ui/footer';
import { hasTabPrintHandler, setTabPrintHandler, triggerTabPrint } from './ui/print';
import { hasTabExportHandler, setTabExportHandler, triggerTabExport } from './ui/exportCsv';

const content = document.getElementById('content') as HTMLElement;

// the sticky table headers (CSV + Spending) stick right below the app header —
// keep its measured height in --appbar-h so the offset never has to be guessed
const appHeader = document.getElementById('app-header') as HTMLElement;
function syncAppBarH(): void {
  document.documentElement.style.setProperty('--appbar-h', `${appHeader.offsetHeight}px`);
}
syncAppBarH();
new ResizeObserver(syncAppBarH).observe(appHeader);

// static about/contact footer — outside the tab content, so it stays visible on every page
renderAppFooter(document.getElementById('app-footer') as HTMLElement);

const RENDERERS: Record<string, (el: HTMLElement) => void> = {
  spending: renderSpending,
  settings: renderSettings,
  csv: renderCsvTab,
  help: renderHelp,
};

/**
 * Re-render the active tab without moving the page or losing the focus.
 *
 * The tabs are rebuilt from scratch on every change (filter typing, a category
 * checkbox, a month toggle). Appending straight into #content means the page is
 * briefly empty, the browser collapses it and clamps scrollY — that is the jump
 * people saw when toggling something in Spending. So the new content is
 * built in a detached host and swapped in with one operation, and the scroll
 * position is restored right after the swap and once more after the next layout
 * pass (the charts measure and re-flow there).
 */
function renderActive(): void {
  const tabBefore = state.activeTab;
  const scrollY = window.scrollY;

  // focus + caret of whatever the user is working in (search-as-you-type, rule editing)
  const active = document.activeElement as HTMLElement | null;
  const fk = active?.getAttribute('data-fk') ?? null;
  const editable = active as HTMLInputElement | HTMLTextAreaElement | null;
  const sel: [number, number] | null =
    editable && typeof editable.selectionStart === 'number' && typeof editable.selectionEnd === 'number'
      ? [editable.selectionStart, editable.selectionEnd]
      : null;

  document.querySelectorAll('[data-tab]').forEach((t) => {
    const el = t as HTMLElement;
    if (el.dataset.tab === state.activeTab) el.setAttribute('data-active', 'true');
    else el.removeAttribute('data-active');
  });
  // the active tab registers its print dialog during render; anything else leaves printing off
  setTabPrintHandler(null);
  setTabExportHandler(null);
  const host = document.createElement('div');
  (RENDERERS[state.activeTab] ?? renderSpending)(host);
  content.replaceChildren(...Array.from(host.childNodes));
  printBtn.disabled = !hasTabPrintHandler();
  printBtn.title = printBtn.disabled ? 'Nothing to print on this page' : 'Print the current page';
  exportBtn.disabled = !hasTabExportHandler();
  exportBtn.title = exportBtn.disabled ? 'No table to export on this page' : 'Export the current table as CSV';

  if (fk) {
    const target = document.querySelector(`[data-fk="${fk}"]`) as HTMLElement | null;
    if (target) {
      target.focus();
      if (sel && typeof (target as HTMLInputElement).setSelectionRange === 'function') {
        try {
          (target as HTMLInputElement).setSelectionRange(sel[0], sel[1]);
        } catch { /* ignore */ }
      }
    }
  }
  keepScroll(tabBefore, scrollY);
}

/** stay exactly where the user was looking, now and after the next layout */
function keepScroll(tab: string, y: number): void {
  const restore = (): void => {
    if (state.activeTab !== tab) return; // a tab switch is allowed to move the page
    if (Math.abs(window.scrollY - y) <= 1) return;
    window.scrollTo({ top: y, left: window.scrollX });
  };
  restore();
  // once more after the next layout: the charts measure and re-flow after the swap,
  // and the browser's scroll anchoring adjusts the offset during that pass
  requestAnimationFrame(() => requestAnimationFrame(restore));
}

// ---------- mobile navigation menu ----------

const menuBtn = document.getElementById('menu-btn') as HTMLButtonElement;
const mobileMenu = document.getElementById('mobile-menu') as HTMLElement;

function closeMenu(): void {
  mobileMenu.classList.add('hidden');
  menuBtn.setAttribute('aria-expanded', 'false');
}

menuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const hidden = mobileMenu.classList.toggle('hidden');
  menuBtn.setAttribute('aria-expanded', String(!hidden));
});
document.addEventListener('click', (e) => {
  if (!mobileMenu.classList.contains('hidden') && !mobileMenu.contains(e.target as Node)) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});

// ---------- URL hash routing: menu clicks write history entries (#spending / #csv / #categories) ----------

type TabKey = typeof state.activeTab;
const HASH_TO_TAB: Record<string, TabKey> = { '#spending': 'spending', '#csv': 'csv', '#categories': 'settings', '#help': 'help' };
const TAB_TO_HASH: Record<TabKey, string> = { spending: '#spending', csv: '#csv', settings: '#categories', help: '#help' };

function applyHash(): void {
  const tab = HASH_TO_TAB[location.hash];
  if (tab && tab !== state.activeTab) {
    state.activeTab = tab;
    closeMenu();
    renderActive();
  }
}

document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((t) => {
  t.addEventListener('click', () => {
    // setting the hash pushes a history entry; the hashchange listener activates the tab
    // (clicking the active tab leaves the hash untouched -> no duplicate history entry)
    location.hash = TAB_TO_HASH[t.dataset.tab as TabKey];
    closeMenu();
  });
});
window.addEventListener('hashchange', applyHash);

// deep link: start on the tab named in the URL; a hash-less start gets the current tab without a history entry
const initialTab = HASH_TO_TAB[location.hash];
if (initialTab) state.activeTab = initialTab;
history.replaceState(null, '', TAB_TO_HASH[state.activeTab]);

// ---------- static header icons (lucide, injected at startup) ----------

menuBtn.appendChild(Ic(Menu, 'size-4'));

document.getElementById('brand-icon')?.appendChild(Ic(Landmark, 'size-5'));
document.getElementById('upload-btn')?.prepend(Ic(Upload, 'size-4'));
document.querySelector('#drop-overlay > div')?.prepend(Ic(FileUp, 'size-12'));

// ---------- theme toggle ----------

const themeBtn = document.getElementById('theme-btn') as HTMLButtonElement;

function isDark(): boolean {
  return document.documentElement.classList.contains('dark');
}

function applyTheme(dark: boolean, persist: boolean): void {
  document.documentElement.classList.toggle('dark', dark);
  themeBtn.replaceChildren(Ic(dark ? Sun : Moon, 'size-4'));
  themeBtn.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
  if (persist) {
    try {
      localStorage.setItem('banking.theme', dark ? 'dark' : 'light');
    } catch { /* ignore */ }
  }
}

applyTheme(isDark(), false);
themeBtn.addEventListener('click', () => applyTheme(!isDark(), true));
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  // follow the OS only when the user never chose a theme explicitly
  let saved: string | null = null;
  try {
    saved = localStorage.getItem('banking.theme');
  } catch { /* ignore */ }
  if (!saved) applyTheme(e.matches, false);
});

// ---------- print button (opens the active tab's print dialog) ----------

const printBtn = document.getElementById('print-btn') as HTMLButtonElement;
printBtn.appendChild(Ic(Printer, 'size-4'));
printBtn.addEventListener('click', () => triggerTabPrint());

// ---------- export button (opens the active tab's CSV export dialog) ----------

const exportBtn = document.getElementById('export-btn') as HTMLButtonElement;
exportBtn.appendChild(Ic(Download, 'size-4'));
exportBtn.addEventListener('click', () => triggerTabExport());

// header add-csv button (the shared picker logic lives in ui/addCsv.ts)
const fileInput = document.getElementById('csv-file-input') as HTMLInputElement;
document.getElementById('upload-btn')!.addEventListener('click', () => fileInput.click());
onCsvPicked(fileInput);

// drag & drop anywhere on the page, on any tab: CSVs open the upload modal,
// JSON files (category settings or a CSV schema) are recognized and imported
const overlay = document.getElementById('drop-overlay')!;
let dragDepth = 0;

function showDropHint(on: boolean): void {
  overlay.classList.toggle('hidden', !on);
  overlay.classList.toggle('grid', on);
}

/** a drag only carries files when the OS puts "Files" in its type list */
function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  showDropHint(true);
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'copy';
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) showDropHint(false);
});
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  showDropHint(false);
  const all = Array.from(e.dataTransfer?.files ?? []);
  const csv = all.filter((f) => /\.csv$/i.test(f.name) || f.type.includes('csv'));
  const json = all.filter((f) => /\.json$/i.test(f.name) || f.type === 'application/json');
  if (csv.length === 0 && json.length === 0) {
    if (all.length > 0) toast('Drop a .csv statement — or a .json with categories / a CSV schema', 'err');
    return;
  }
  // JSON files import themselves (category settings vs mapper schema is detected)
  for (const f of json) await importJsonFile(f);
  if (csv.length > 0) await doUpload(csv);
});

subscribe(renderActive);

// ---------- PWA: offline support via service worker (prod only; a dev SW would fight HMR) ----------
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline support unavailable — app still works */ });
  });
}

bootstrap()
  .then(renderActive)
  .catch((e) => {
    toast(`failed to load: ${String(e)}`, 'err');
    renderActive();
  });
