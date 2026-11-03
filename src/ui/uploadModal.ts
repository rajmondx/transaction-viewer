import { Check, Copy, FileUp, Pencil, RefreshCcw, Star, Trash2, TriangleAlert, Wand2, X } from 'lucide';
import type { Mapper, MapperColumns } from '../types';
import { state, addUploads } from '../state';
import { allMappers, deleteMapper, isBuiltin, listSaved, renameMapper, saveMapper } from '../storage/mappers';
import {
  MAPPER_FIELDS, detectBestMapper, guessColumns, hasRequiredColumns, missingColumns,
  parseCsvHeaders, parseMapper, scoreSchema, serializeMapper,
} from '../csv/schemas';
import { parseWithMapper } from '../csv/parse';
import { C, clear, cx, downloadText, h, num2, toast } from './util';
import { Ic } from './icons';

/**
 * The upload dialog: every dropped/selected CSV gets its schema DETECTED
 * against built-in + saved mappers, and the user can confirm, switch to any
 * preset, or map columns manually (with live preview) BEFORE anything is
 * stored. Saved mappers can be renamed/duplicated/exported/deleted here.
 * Also reused to re-map already stored files ("Mappers…" on the CSV tab).
 */

interface Entry {
  name: string;
  content: string;
  headers: string[];
  sel: { kind: 'preset'; name: string } | { kind: 'custom' };
  /** working custom columns (seeded by detection/guess, or from a preset when editing) */
  columns: MapperColumns;
  customName: string;
}

let overlay: HTMLElement | null = null;

function onEsc(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeModal();
}

function closeModal(): void {
  if (overlay) {
    overlay.remove();
    overlay = null;
  }
  document.removeEventListener('keydown', onEsc);
}

function cloneMapper(m: Mapper): Mapper {
  return { name: m.name, columns: { ...m.columns } };
}

function resolveMapper(e: Entry): Mapper {
  if (e.sel.kind === 'preset') {
    const want = e.sel.name;
    const found = allMappers().find((m) => m.name === want);
    if (found) return cloneMapper(found);
    // preset vanished (deleted while the dialog is open) → continue with its columns as custom
    e.sel = { kind: 'custom' };
    e.customName = want;
  }
  return { name: e.customName.trim() || 'Custom', columns: { ...e.columns } };
}

export function openUploadModal(
  files: Array<{ name: string; content: string; mapper?: Mapper | null }>,
  mode: 'upload' | 'remap' = 'upload',
): void {
  closeModal();
  if (files.length === 0) {
    toast('Nothing to map — select CSV files first');
    return;
  }

  const entries: Entry[] = files.map((f) => {
    const headers = parseCsvHeaders(f.content);
    if (mode === 'remap' && f.mapper) {
      const asPreset = allMappers().find((m) => m.name === f.mapper!.name);
      return {
        name: f.name, content: f.content, headers,
        sel: asPreset ? ({ kind: 'preset', name: asPreset.name } as const) : ({ kind: 'custom' } as const),
        columns: { ...f.mapper.columns },
        customName: asPreset ? '' : f.mapper.name,
      };
    }
    const best = detectBestMapper(headers, allMappers());
    return {
      name: f.name, content: f.content, headers,
      sel: best ? ({ kind: 'preset', name: best.mapper.name } as const) : ({ kind: 'custom' } as const),
      columns: best ? { ...best.mapper.columns } : guessColumns(headers),
      customName: '',
    };
  });

  const panel = h('div');

  // ---------- mapper management section ----------
  const renderManager = (): HTMLElement => {
    const box = h('div', { class: 'flex flex-col gap-1.5' });
    const saved = listSaved();
    box.appendChild(h('span', { class: cx(C.label, 'flex items-center gap-1') }, Ic(Star, 'size-3.5'), `Saved mappers (${saved.length}) — built-in: ${allMappers().length - saved.length}`));
    if (saved.length === 0) box.appendChild(h('span', { class: cx(C.muted, C.tiny), text: 'custom mappers you save here appear in the dropdowns of every future upload' }));
    for (const m of saved) {
      const used = mode === 'remap' && state.loaded.some((f) => f.mapper?.name === m.name);
      box.appendChild(h('div', { class: 'flex flex-wrap items-center gap-2 border border-border bg-card px-3 py-1.5 text-[12.5px]' },
        h('b', { text: m.name }),
        h('span', { class: cx(C.muted, 'font-mono text-[11px]'), text: `${m.columns.bookingDate} · ${m.columns.text} · ${m.columns.amount ?? `${m.columns.credit ?? '?'}/${m.columns.debit ?? '?'}`}` }),
        used ? h('span', { class: C.badgeMuted, text: 'in use' }) : null,
        h('span', { class: 'flex-1' }),
        h('button', { class: cx(C.btn, 'px-2 py-0.5'), title: 'rename', onclick: () => {
          const name = (prompt('Rename mapper to:', m.name) || '').trim();
          if (!name || name === m.name) return;
          try { renameMapper(m.name, name); render(); } catch (e) { toast(String((e as Error).message ?? e), 'err'); }
        } }, Ic(Pencil, 'size-3'), 'rename'),
        h('button', { class: cx(C.btn, 'px-2 py-0.5'), title: 'duplicate with a new name', onclick: () => {
          const name = (prompt('Save a copy as:', `${m.name} copy`) || '').trim();
          if (!name) return;
          try { saveMapper({ name, columns: { ...m.columns } }); render(); } catch (e) { toast(String((e as Error).message ?? e), 'err'); }
        } }, Ic(Copy, 'size-3'), 'copy'),
        h('button', { class: cx(C.btn, 'px-2 py-0.5'), title: 'export JSON', onclick: () => downloadText(`${m.name}.mapper.json`, serializeMapper(m)) }, Ic(FileUp, 'size-3'), 'export'),
        h('button', { class: cx(C.btnDanger, 'px-2 py-0.5'), title: 'delete from registry (already-uploaded files keep their schema snapshot)', onclick: () => {
          if (!confirm(`Delete mapper "${m.name}"? Stored files keep their snapshot.`)) return;
          try { deleteMapper(m.name); render(); } catch (e) { toast(String((e as Error).message ?? e), 'err'); }
        } }, Ic(Trash2, 'size-3')),
      ));
    }
    const importInput = h('input', { attrs: { type: 'file', accept: '.json,application/json' }, class: 'hidden' }) as HTMLInputElement;
    importInput.onchange = async () => {
      const file = importInput.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const raw = JSON.parse(text) as { name?: unknown; columns?: Record<string, unknown> };
        if (typeof raw.name !== 'string' || !raw.name.trim()) throw new Error('mapper JSON needs a "name"');
        const nm = raw.name.trim();
        if (isBuiltin(nm)) throw new Error(`"${nm}" is a built-in name`);
        // parseMapper falls back to the built-in ABS schema when required columns are missing
        const m = parseMapper(raw);
        if (m.name !== nm) throw new Error('mapper JSON is missing required columns (bookingDate, text, credit/debit or amount)');
        saveMapper(m);
        toast(`Imported mapper "${nm}"`);
        render();
      } catch (e) {
        toast(`Import failed: ${(e as Error).message}`, 'err');
      }
    };
    box.appendChild(h('button', { class: cx(C.btn, 'self-start'), onclick: () => importInput.click() }, Ic(FileUp, 'size-3.5'), 'Import mapper JSON'));
    box.appendChild(importInput);
    return box;
  };

  // ---------- one file card ----------
  const renderEntry = (e: Entry, i: number): HTMLElement => {
    const mapper = resolveMapper(e);
    const res = hasRequiredColumns(mapper.columns)
      ? parseWithMapper(e.content, e.name, mapper)
      : { txs: [], warnings: [], missing: ['(required fields not mapped)'] };
    const preset = allMappers();
    const selName = e.sel.kind === 'preset' ? e.sel.name : '__custom';

    const sel = h('select', { class: cx(C.input, 'max-w-[280px]') },
      ...preset.map((m) => h('option', { text: m.name, attrs: { value: m.name } })),
      h('option', { text: 'Custom mapping…', attrs: { value: '__custom' } }),
    ) as HTMLSelectElement;
    sel.value = selName;
    sel.onchange = () => {
      if (sel.value === '__custom') {
        e.sel = { kind: 'custom' };
        if (!e.customName) e.customName = `${e.name.replace(/\.csv$/i, '')} schema`;
      } else {
        const found = preset.find((m) => m.name === sel.value)!;
        e.sel = { kind: 'preset', name: found.name };
        e.columns = { ...found.columns };
      }
      render();
    };

    const score = scoreSchema(e.headers, mapper);
    const missing = missingColumns(e.headers, mapper);

    const card = h('div', { class: 'flex flex-col gap-2 border border-border bg-card p-3' },
      h('div', { class: 'flex flex-wrap items-center gap-2' },
        h('b', { class: 'text-[13px]', text: e.name }),
        mode === 'remap' ? h('span', { class: C.badgeMuted, text: 'stored file' }) : null,
        res.missing.length > 0
          ? h('span', { class: 'border border-danger/40 bg-danger/10 px-2 py-px text-[11px] text-danger', text: 'does not match' })
          : h('span', { class: 'border border-success/40 bg-success/10 px-2 py-px text-[11px] text-success', text: `${res.txs.length} transactions · ${Math.round(score * 100)}% header match` }),
        h('span', { class: 'flex-1' }),
        preset.length > 1 && mode === 'upload'
          ? h('button', { class: cx(C.btn, 'px-2 py-1'), title: 'use this selection for all files', onclick: () => {
            for (const other of entries) {
              other.sel = e.sel.kind === 'preset' ? { kind: 'preset', name: e.sel.name } : { kind: 'preset', name: mapper.name };
              other.columns = { ...e.columns };
            }
            render();
          } }, Ic(RefreshCcw, 'size-3'), 'all files') : null,
        entries.length > 1
          ? h('button', { class: cx(C.btnDanger, 'px-2 py-1'), title: 'remove from this upload (file itself untouched)', onclick: () => {
            entries.splice(i, 1);
            render();
          } }, Ic(X, 'size-3.5')) : null,
      ),
      h('div', { class: 'flex flex-wrap items-center gap-2' },
        h('span', { class: C.label, text: 'Schema' }), sel),
      res.missing.length > 0
        ? h('div', { class: 'flex items-start gap-2 border border-danger/40 bg-danger/10 px-3 py-2 text-[12.5px] text-danger' },
          Ic(TriangleAlert, 'size-4 shrink-0 mt-0.5'), `Missing columns for "${mapper.name}": ${res.missing.join(', ')} — pick another schema or map columns as Custom.`)
        : null,
      e.sel.kind === 'custom' ? renderEditor(e) : null,
      res.txs.length > 0 ? previewTable(res.txs) : null,
      missing.length > 0 && res.missing.length === 0
        ? h('span', { class: cx(C.muted, C.tiny), text: `optional columns not in this file: ${missing.join(', ')}` }) : null,
    );
    return card;
  };

  // ---------- custom column grid + save-as-mapper ----------
  const renderEditor = (e: Entry): HTMLElement => {
    const nameIn = h('input', { class: cx(C.input, 'max-w-[220px]'), attrs: { type: 'text', value: e.customName, placeholder: 'mapper name, e.g. PostFinance' } }) as HTMLInputElement;
    nameIn.oninput = () => { e.customName = nameIn.value; };
    const cols: Partial<Record<keyof MapperColumns, string>> = e.columns;

    const grid = h('div', { class: 'grid gap-1.5 sm:grid-cols-2' });
    for (const f of MAPPER_FIELDS) {
      const s = h('select', { class: cx(C.input, 'w-full') },
        h('option', { text: f.required ? '— required —' : '— none —', attrs: { value: '' } }),
        ...e.headers.map((hd) => h('option', { text: hd, attrs: { value: hd } })),
      ) as HTMLSelectElement;
      const cur = e.columns[f.key];
      s.value = cur && e.headers.includes(cur) ? cur : '';
      s.onchange = () => {
        cols[f.key] = s.value;
        render();
      };
      grid.appendChild(h('div', { class: 'flex flex-col gap-1' },
        h('span', { class: cx(C.tiny, 'font-semibold', f.required ? 'text-primary' : C.muted), text: `${f.label}${f.required ? ' *' : ''}` }),
        s));
    }

    const saveBtn = h('button', {
      class: C.btn, title: 'keep this mapping in the registry for future uploads', onclick: () => {
        const nm = e.customName.trim();
        if (!nm) { toast('Give the mapper a name first', 'err'); return; }
        if (isBuiltin(nm)) { toast('That name belongs to a built-in schema', 'err'); return; }
        if (!hasRequiredColumns(e.columns)) { toast('Map date, description and an amount column first', 'err'); return; }
        try {
          saveMapper({ name: nm, columns: { ...e.columns } });
          e.sel = { kind: 'preset', name: nm };
          toast(`Mapper "${nm}" saved for future uploads`);
          render();
        } catch (err) { toast(String((err as Error).message ?? err), 'err'); }
      },
    }, Ic(Wand2, 'size-3.5'), 'Save as mapper');

    return h('div', { class: 'flex flex-col gap-2 border border-primary/30 bg-accent-soft p-2.5' },
      h('div', { class: 'flex flex-wrap items-center gap-2' },
        h('span', { class: C.label, text: 'Name' }), nameIn, saveBtn),
      grid);
  };

  // ---------- small row preview ----------
  const previewTable = (txs: ReturnType<typeof parseWithMapper>['txs']): HTMLElement => {
    const rows = txs.slice(0, 4).map((t) => h('tr', { class: 'border-b border-border/60' },
      h('td', { class: cx('px-2 py-1 font-mono text-[11px]', C.muted), text: t.bookingDate || '?' }),
      h('td', { class: 'max-w-[300px] overflow-hidden text-ellipsis whitespace-nowrap px-2 py-1', text: t.text, title: t.text }),
      h('td', { class: cx('px-2 py-1 font-mono text-[11px] text-right', t.credit > 0 ? 'text-success' : C.muted), text: t.credit > 0 ? num2(t.credit) : '' }),
      h('td', { class: cx('px-2 py-1 font-mono text-[11px] text-right', t.debit > 0 ? 'text-danger' : C.muted), text: t.debit > 0 ? `−${num2(t.debit)}` : '' }),
    ));
    return h('div', { class: 'overflow-hidden border border-border' },
      h('table', { class: 'w-full border-collapse text-xs' },
        h('thead', {}, h('tr', {},
          h('th', { class: cx(C.th, 'px-2 py-1 text-left'), text: 'Date' }),
          h('th', { class: cx(C.th, 'px-2 py-1 text-left'), text: 'Description' }),
          h('th', { class: cx(C.th, 'px-2 py-1 text-right'), text: 'Credit' }),
          h('th', { class: cx(C.th, 'px-2 py-1 text-right'), text: 'Debit' }),
        )),
        h('tbody', {}, ...rows)));
  };

  // ---------- render + footer ----------
  const addBtn = h('button', { class: C.btnPrimary, onclick: async () => {
    const items = entries.map((e) => ({ name: e.name, content: e.content, mapper: resolveMapper(e) }));
    closeModal();
    await addUploads(items);
  } }, Ic(Check, 'size-3.5'), mode === 'remap' ? 'Apply mappings' : 'Add to dataset');

  const render = (): void => {
    clear(panel);
    entries.forEach((e, i) => panel.appendChild(renderEntry(e, i)));
    if (entries.length === 0) panel.appendChild(h('div', { class: C.muted, text: 'no files left in this upload' }));
    panel.appendChild(h('div', { class: 'mt-2 flex flex-col gap-2 border border-border bg-subtle/50 p-2.5' }, renderManager()));
    const anyBroken = entries.some((e) => {
      const m = resolveMapper(e);
      return !hasRequiredColumns(m.columns) || parseWithMapper(e.content, e.name, m).missing.length > 0;
    });
    addBtn.disabled = anyBroken || entries.length === 0;
    addBtn.classList.toggle('opacity-50', anyBroken);
    addBtn.title = anyBroken ? 'Fix every red file first (choose another schema or map it as custom)' : '';
  };

  const card = h('div', {
    class: 'max-h-[88vh] w-full max-w-[680px] overflow-y-auto border border-border bg-card p-4 shadow-card',
  },
    h('div', { class: 'mb-1 flex items-center gap-2' },
      h('h3', { class: 'flex items-center gap-2 text-[15px] font-semibold' },
        Ic(mode === 'remap' ? Wand2 : FileUp, 'size-4'),
        mode === 'remap' ? 'CSV schemas of stored files' : 'Add CSV files'),
      h('button', { class: cx(C.btn, 'ml-auto px-2 py-1'), onclick: () => closeModal(), text: '✕', title: 'Close (Esc)' })),
    h('p', { class: cx(C.muted, 'mb-3 text-[12.5px]') },
      mode === 'remap'
        ? 'Each stored file keeps its own schema snapshot. Re-map here to change one file — stored files are only re-parsed when you change them explicitly.'
        : 'Schemas are auto-detected from the header. Confirm, pick a preset, or map columns yourself — nothing is stored before you click Add.'),
    panel,
    h('div', { class: 'mt-4 flex flex-wrap items-center gap-2' },
      addBtn,
      h('button', { class: cx(C.btn, 'ml-auto'), onclick: () => closeModal(), text: 'Cancel' })),
  );

  overlay = h('div', {
    class: 'fixed inset-0 z-[110] grid place-items-center bg-black/45 p-3 backdrop-blur-[2px]',
    onclick: (ev: MouseEvent) => { if (ev.target === overlay) closeModal(); },
  }, card);
  document.body.appendChild(overlay);
  document.addEventListener('keydown', onEsc);
  render();
}
