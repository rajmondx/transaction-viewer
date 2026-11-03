import { FileUp, Play, Plus } from 'lucide';
import { doUpload } from './uploadFlow';
import { loadDemoData } from './demoData';
import { C, cx, h } from './util';
import { Ic } from './icons';

/**
 * The "Add CSV" entry points shared by the header button, the CSV tab and the
 * empty states: pick files -> the upload modal opens (nothing is stored until
 * the mappings there are confirmed). Drag & drop of CSVs is wired in main.ts.
 */

/** Wire a file input to the upload flow; the value resets so the same file can be picked again. */
export function onCsvPicked(input: HTMLInputElement): void {
  input.onchange = async () => {
    if (input.files && input.files.length > 0) {
      await doUpload(Array.from(input.files));
      input.value = '';
    }
  };
}

/** Create a hidden CSV file input and the button that opens it — append BOTH to the DOM. */
export function csvPicker(label = 'Add CSV'): { input: HTMLInputElement; button: HTMLElement } {
  const input = h('input', {
    attrs: { type: 'file', accept: '.csv,text/csv', multiple: 'multiple', tabindex: '-1' },
  }) as HTMLInputElement;
  input.classList.add('hidden');
  onCsvPicked(input);
  const button = h('button', { class: C.btnPrimary, dataset: { self: '1' }, onclick: () => input.click() }, Ic(Plus, 'size-4'), label);
  return { input, button };
}

/**
 * Info box shown on pages that need stored CSVs (Spending, CSV) while none exist.
 * Clicking anywhere on the box opens the file picker — except on the controls that
 * carry their own action (marked with data-self).
 */
export function noCsvCard(detail?: string): HTMLElement {
  const { input, button } = csvPicker();
  const demo = h('button', {
    class: cx(C.link, 'inline-flex items-center gap-1'),
    dataset: { self: '1' },
    title: 'An anonymized sample statement (English texts, common shops) — stored like any upload and removable on the CSV page',
    onclick: () => void loadDemoData(),
  }, Ic(Play, 'size-3.5'), 'Load demo data');
  const box = h('div', {
    class: cx(
      // not C.card: the dashed frame is what makes it read as a drop target
      'flex cursor-pointer flex-col items-center gap-2.5 border border-dashed border-input bg-card px-6 py-10 text-center shadow-card',
      'transition-colors hover:border-primary hover:bg-accent-soft/40',
    ),
    attrs: { role: 'button', tabindex: '0' },
    title: 'Choose a CSV file — or drop one anywhere on this page',
    // controls with their own action must not open the picker twice
    onclick: (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-self]')) input.click();
    },
    onkeydown: (e: KeyboardEvent) => {
      if (e.target === box && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        input.click();
      }
    },
  },
    Ic(FileUp, 'size-9 text-muted-foreground'),
    h('b', { class: 'text-[15px]', text: 'Upload first a CSV' }),
    h('span', { class: cx(C.muted, 'max-w-[460px] text-[12.5px]') },
      detail ?? 'Click here to choose a file, or drop a CSV anywhere on this page — the schema is detected before anything is stored.'),
    button,
    input,
    h('span', { class: cx(C.muted, 'flex items-center gap-1.5 text-[12px]') }, 'No file at hand?', demo),
  );
  return box;
}
