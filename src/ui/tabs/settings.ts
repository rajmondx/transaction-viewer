import { ArrowDown, ArrowUp, Braces, CalendarDays, Check, ChevronDown, ChevronRight, Copy, CreditCard, FileJson, FilePlus, FolderCog, FolderInput, FolderOutput, Inbox, ListTree, Palette, PenLine, Pencil, Plus, RefreshCw, Save, Sparkles, Star, Tag, Trash2, TriangleAlert, Undo2, X } from 'lucide';
import type { Category, SearchRule, Settings, Tx } from '../../types';
import { state, emit, loadActiveSettings, reloadSettingsList, selectSettings } from '../../state';
import { emptySettings, parseSettings, serializeSettings } from '../../categories/schema';
import { buildTree, flattenTree, UNCAT } from '../../categories/engine';
import { auditSettings, decide, explainTx, hiddenRows, isDead, undecidedRows, type CategoryAudit, type Claimant, type ConflictReport, type Decision } from '../../categories/conflicts';
import { autoColorize } from '../../categories/colors';
import { openAiPromptDialog } from '../aiCategories';
import * as sstore from '../../storage/settings';
import { C, clear, colorFor, cx, downloadText, dmy, h, num2, toast } from '../util';
import { Ic } from '../icons';

let draft: Settings | null = null;
let dirty = false;
let showRaw = false;
let rawText = '';
let rawError = '';

function markDirty(): void {
  dirty = true;
}

function ensureDraft(): void {
  if (!draft || draft.name !== state.activeSettingsName) {
    draft = structuredClone(state.settings);
    dirty = false;
    showRaw = false;
    rawError = '';
    openConflict = null; // the panel points at categories of the bundle it was opened in
  }
}

/** preview + conflicts: one pass over the currently loaded transactions */
export function renderSettings(container: HTMLElement): void {
  ensureDraft();
  clear(container);
  const d = draft!;
  const report = auditSettings(d, state.txs);

  const layout = h('div', { class: 'grid items-start gap-4 lg:grid-cols-[250px_1fr]' });
  layout.appendChild(sidebar(d, report));
  layout.appendChild(editor(d, report));
  container.appendChild(layout);
}

/** scrolls the editor to a category card and flashes it */
function jumpToCat(idx: number): void {
  const card = document.querySelector(`[data-cat="${idx}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('flash-card');
  setTimeout(() => card.classList.remove('flash-card'), 900);
}

/** sidebar tree of the current draft categories (parents + children); click jumps to the card */
function treeBox(d: Settings): HTMLElement {
  const roots = buildTree(d).filter((r) => r.tag !== UNCAT);
  const flat = flattenTree(roots);
  const rows = flat.map((n) => {
    const idx = d.categories.findIndex((c) => c.tag === n.tag);
    const childCount = n.children.length;
    const dot = h('span', { class: C.dot });
    dot.style.background = n.category?.color ?? '#9aa2ad';
    const row = h('div', {
      class: cx(
        'flex cursor-pointer items-center gap-2 overflow-hidden whitespace-nowrap py-[3px] pr-2 text-[12.5px] hover:bg-accent-soft',
        n.category && !n.category.enabled && 'opacity-50',
      ),
      title: n.category?.rules.length ? `rules: ${n.category.rules.map((r) => r.text).join(', ')}` : 'no own rules',
      onclick: () => jumpToCat(idx),
      style: { paddingLeft: `${10 + n.depth * 18}px` },
    },
      dot,
      h('span', { class: cx('truncate', n.depth === 0 && 'font-semibold'), text: n.tag }),
    );
    if (childCount > 0) row.appendChild(h('span', { class: C.badgeMuted, style: { marginLeft: 'auto' }, text: String(childCount) }));
    return row;
  });
  return h('div', { class: 'mb-3.5 border-t border-border pt-2.5' },
    h('h4', { class: cx(C.label, 'flex items-center gap-1') }, Ic(ListTree, 'size-3.5'), 'Category tree'),
    flat.length ? h('div', { class: 'my-1.5 max-h-[260px] overflow-y-auto' }, ...rows) : h('div', { class: cx(C.muted, C.tiny), text: 'no categories yet' }),
    h('div', { class: cx(C.muted, C.tiny), text: 'flat list order = priority; indentation = tag_father' }),
  );
}

// ---------- sidebar: conflicts ----------

/** one line of the conflict list */
interface Finding {
  catIndex: number;
  /** rule the finding is about, when it is about one single rule */
  ruleIndex: number | null;
  /** rows can be listed for it (the ones about names and empty tags cannot) */
  openable: boolean;
  /** red instead of amber: the value cannot work the way the editor shows it */
  danger: boolean;
  text: string;
  title: string;
}

/** full explanation of what a category loses and to whom */
function shadowNote(a: CategoryAudit): string {
  const who = a.shadowedBy.map((s) => `${s.tag} (#${s.catIndex + 1}): ${s.count}`).join(' · ');
  return `${a.wouldMatch} loaded transaction(s) match this category's own rules; ${a.won} stay here. The rest go to a category higher up — ${who}. To win them, move this category above those (↑ priority).`;
}

/** short chip label: "9 hidden by Income +1" */
function shadowLabel(a: CategoryAudit): string {
  const top = a.shadowedBy[0];
  const more = a.shadowedBy.length > 1 ? ` +${a.shadowedBy.length - 1}` : '';
  return `${isDead(a) ? 'never wins · ' : ''}${hiddenRows(a)} hidden by ${top ? top.tag : '?'}${more}`;
}

/**
 * Where "first match wins" is silently costing a category its rows, plus the
 * duplicates that need no transactions to spot. Matching itself is untouched —
 * this only shows what the priority order already does.
 */
function conflictBox(d: Settings, report: ConflictReport): HTMLElement {
  const findings: Finding[] = [];

  // measured: rows a category's own rules match, taken by someone higher up
  const hidden = report.audits
    .filter((a) => hiddenRows(a) > 0)
    .sort((x, y) => Number(isDead(y)) - Number(isDead(x)) || hiddenRows(y) - hiddenRows(x) || x.catIndex - y.catIndex);
  for (const a of hidden) {
    findings.push({
      catIndex: a.catIndex,
      ruleIndex: null,
      openable: true,
      danger: false,
      text: `${a.tag} — ${shadowLabel(a)}`,
      title: `${shadowNote(a)} Click to list the transactions.`,
    });
  }

  // static: the same rule again further down can never add a match
  report.ruleOwner.forEach((owners, i) => {
    d.categories[i].rules.forEach((_, ri) => {
      const owner: number | undefined = owners[ri];
      if (owner == null || owner < 0) return;
      const from = owner === i ? 'another rule in this category' : `#${owner + 1} ${d.categories[owner].tag}`;
      findings.push({
        catIndex: i,
        ruleIndex: ri,
        openable: true,
        danger: false,
        text: `${d.categories[i].tag} · ${ruleLabel(d.categories[i], ri)} — duplicate`,
        title: owner === i
          ? `This category already matches on another of its rules, and one hit is enough — this line decides nothing. Click to list the transactions it repeats.`
          : `The same rule is already checked in ${from}, so every row this line matches is decided before it gets here. Click to list those rows.`,
      });
    });
  });

  for (const t of report.duplicateTags) {
    findings.push({
      catIndex: t.indexes[0],
      ruleIndex: null,
      openable: false,
      danger: true,
      text: `tag "${t.tag}" used ${t.indexes.length}×`,
      title: `Categories are identified by their tag, so #${t.indexes.map((i) => i + 1).join(', #')} share one row in the tree and in the Spending view — their transactions add up together and the tree jumps to the first card only. Give them distinct names.`,
    });
  }

  for (const i of report.matchAll) {
    findings.push({
      catIndex: i,
      ruleIndex: null,
      openable: false,
      danger: true,
      text: `${d.categories[i].tag} — empty search text`,
      title: 'An empty search tag matches EVERY transaction, so this category wins the whole account unless another one is listed above it. Remove the rule.',
    });
  }

  const shown = findings.slice(0, 12);
  const rows = shown.map((f) => h('div', {
    class: cx('flex cursor-pointer items-start gap-1.5 py-[3px] pr-2 text-[11.5px] hover:bg-accent-soft',
      f.danger ? 'font-semibold text-danger' : 'text-warning'),
    title: f.title,
    onclick: () => {
      if (f.openable) toggleConflict(f.catIndex, f.ruleIndex);
      jumpToCat(f.catIndex);
    },
  }, Ic(TriangleAlert, 'size-3 shrink-0 mt-px'), h('span', { class: 'min-w-0', text: f.text })));
  if (findings.length > shown.length) {
    rows.push(h('div', { class: cx(C.muted, 'py-[3px] text-[11px]'), text: `+ ${findings.length - shown.length} more` }));
  }

  const noData = state.txs.length === 0;
  return h('div', { class: 'mb-3.5 border-t border-border pt-2.5' },
    h('h4', { class: cx(C.label, 'flex items-center gap-1') },
      Ic(TriangleAlert, 'size-3.5'), 'Conflicts',
      findings.length ? h('span', { class: cx(C.chipWarn, 'ml-auto'), text: String(findings.length) }) : null),
    d.categories.length === 0
      ? h('div', { class: cx(C.muted, 'py-1 text-[11px]'), text: 'no categories yet' })
      : rows.length
        ? h('div', { class: 'my-1.5 max-h-[240px] overflow-y-auto' }, ...rows)
        : h('div', {
          class: cx(C.muted, 'py-1 text-[11px]'),
          // with nothing loaded the overlaps simply cannot be measured yet
          text: noData ? 'no duplicates — load a CSV to see hidden rules too' : 'nothing hidden by the priority order',
        }),
    rows.length && noData
      ? h('div', { class: cx(C.muted, 'py-1 text-[11px]'), text: 'hidden rows need loaded transactions' })
      : null,
  );
}

// ---------- conflict drill-down ----------

/** the panel open under a category card; `ruleIndex` null = the whole category */
let openConflict: { catIndex: number; ruleIndex: number | null } | null = null;

function toggleConflict(catIndex: number, ruleIndex: number | null): void {
  const o = openConflict;
  openConflict = o && o.catIndex === catIndex && o.ruleIndex === ruleIndex ? null : { catIndex, ruleIndex };
  emit();
}

/** how a rule is written in the panel: its text plus the flag it carries */
function ruleLabel(c: Category, ri: number): string {
  if (ri < 0) return 'any transaction on this account';
  const r = c.rules[ri];
  if (!r) return '?';
  if (r.text === '') return 'empty search text (matches everything)';
  const flag = r.regex ? ' .*' : r.fuzzy ? ' ≈' : r.caseSensitive ? ' Aa' : '';
  return `"${r.text}"${flag}`;
}

/** one transaction, with every rule that claims it: green decided it, red was overruled */
function claimRow(d: Settings, tx: Tx, dec: Decision | null, zebra: number): HTMLElement {
  const chips = explainTx(d, tx).flatMap((cl: Claimant): HTMLElement[] => {
    const c = d.categories[cl.catIndex];
    // a category matched by its IBAN list alone has no rule to name — show that as one chip
    const hits = cl.rules.length > 0 ? cl.rules : [-1];
    return hits.map((ri) => {
      const decided = dec !== null && dec.catIndex === cl.catIndex && dec.ruleIndex === ri;
      return h('span', {
        class: cx(decided ? C.chipOk : C.chipBad, 'max-w-full truncate'),
        title: decided
          ? `decides this row — #${cl.catIndex + 1} ${cl.tag}`
          : `matches this row too, but #${dec ? dec.catIndex + 1 : '?'} ${dec ? d.categories[dec.catIndex].tag : 'nothing'} decides it`,
      },
        h('b', { text: `#${cl.catIndex + 1} ${cl.tag}` }),
        h('span', { text: ` ${ruleLabel(c, ri)}` }));
    });
  });
  return h('div', {
    class: cx('grid grid-cols-[84px_1fr_96px] gap-x-2.5 gap-y-1 border-b border-border/60 px-2 py-1 text-[12.5px]',
      zebra % 2 === 0 ? 'bg-card' : 'bg-transparent'),
  },
    h('span', { class: 'font-mono text-muted-foreground', text: dmy(tx.bookingDate) }),
    h('span', { class: 'truncate', text: tx.text, title: tx.text }),
    h('span', { class: cx('text-right tabular-nums', tx.credit > 0 ? 'text-success' : 'text-danger'), text: tx.credit > 0 ? `+${num2(tx.credit)}` : `−${num2(tx.debit)}` }),
    h('div', { class: 'col-span-3 flex flex-wrap items-center gap-1.5' }, ...chips),
  );
}

/** the transactions behind a conflict finding, each showing which rule decided it */
function conflictPanel(d: Settings, catIndex: number, ruleIndex: number | null): HTMLElement {
  const cat = d.categories[catIndex];
  const rows = undecidedRows(d, state.txs, catIndex, ruleIndex);
  const shown = rows.slice(0, 150);
  const body: HTMLElement[] = [];

  if (state.txs.length === 0) {
    body.push(h('div', { class: cx(C.muted, 'px-2 py-2 text-[12px]'), text: 'Load a CSV to see which transactions this conflicts on — overlaps between rules can only be measured against real rows.' }));
  } else if (rows.length === 0) {
    body.push(h('div', { class: cx('px-2 py-2 text-[12px]'), text: 'Nothing left in conflict — this one decides every row it matches now.' }));
  } else {
    for (const [ri, tx] of shown.entries()) body.push(claimRow(d, tx, decide(d, tx), ri));
    if (rows.length > shown.length) {
      body.push(h('div', { class: cx(C.muted, 'px-2 pt-1 text-[11.5px]'), text: `… ${rows.length - shown.length} more` }));
    }
  }

  return h('div', { class: 'mt-2.5 border-t border-border pt-2' },
    h('div', { class: 'flex flex-wrap items-center gap-2' },
      h('span', { class: cx(C.label, 'flex items-center gap-1') }, Ic(TriangleAlert, 'size-3.5'), 'In conflict'),
      h('span', {
        class: cx(C.muted, 'min-w-0 flex-1 text-[11.5px]'),
        text: ruleIndex == null
          ? `${cat.tag} matches ${rows.length} transaction(s) it does not decide`
          : `${ruleLabel(cat, ruleIndex)} matches ${rows.length} transaction(s) it cannot decide`,
      }),
      h('button', {
        class: cx(C.btn, 'px-2 py-1'), title: 'close', onclick: () => { openConflict = null; emit(); },
      }, Ic(X, 'size-3.5'))),
    h('div', { class: 'mt-1.5 max-h-[340px] overflow-y-auto border border-border' }, ...body),
    h('div', { class: cx(C.muted, 'mt-1 text-[11px]') },
      h('span', { class: cx(C.chipOk, 'mr-1.5'), text: 'green' }), 'decided the row',
      h('span', { class: cx(C.chipBad, 'mx-1.5 ml-2'), text: 'red' }), 'matched too, but a category or rule above it won'),
  );
}

// ---------- sidebar: settings file management ----------

function sidebar(d: Settings, report: ConflictReport): HTMLElement {
  const fileBtns = state.settingsFiles.map((f) =>
    h('button', {
      class: cx(
        'flex w-full cursor-pointer items-center gap-2 border px-3 py-2 text-left text-[13px] transition-colors',
        f.name === d.name ? 'border-primary/40 bg-accent-soft font-semibold text-primary' : 'border-border bg-card text-foreground hover:border-input',
      ),
      onclick: async () => {
        if (dirty && !confirm('Discard unsaved changes in this settings file?')) return;
        await selectSettings(f.name);
        draft = null;
      },
    }, Ic(FileJson, 'size-3.5 shrink-0'), h('span', { text: f.name }), f.isDefault ? h('span', { class: 'border border-success/30 bg-success/10 px-1.5 py-px text-[10px] text-success', text: 'default' }) : null),
  );

  const importInput = h('input', { attrs: { type: 'file', accept: '.json,application/json' } }) as HTMLInputElement;
  importInput.classList.add('hidden');
  importInput.onchange = async () => {
    const file = importInput.files?.[0];
    if (!file) return;
    const text = await file.text();
    const base = file.name.replace(/\.json$/i, '');
    let name = prompt('Save imported settings as:', base === 'default-category-setting' ? 'default' : base) || '';
    name = name.trim();
    if (!name) return;
    try {
      sstore.putSettingsText(name, text); // validates { mapper, categories }
      reloadSettingsList();
      await selectSettings(name);
      draft = null;
      toast(`Imported settings "${name}"`);
    } catch (e) {
      toast(`Import failed: ${(e as Error).message}`, 'err');
    }
  };

  return h('aside', {
    // sticky only from lg up: on phones/tablets the sidebar would float over the cards
    // below it — there it simply sits on top of them
    class: cx(C.card, 'p-3.5 lg:sticky lg:top-[80px]'),
  },
    h('h3', { class: 'mb-2.5 flex items-center gap-1.5 text-sm font-semibold' }, Ic(FolderCog, 'size-4'), 'Settings files'),
    h('div', { class: 'mb-3 flex flex-col gap-1' },
      ...fileBtns,
      fileBtns.length === 0 ? h('div', { class: C.muted, text: 'none yet' }) : null),
    treeBox(d),
    conflictBox(d, report),
    h('div', { class: 'flex w-full flex-col gap-1.5' },
      h('button', {
        class: cx(C.btn, 'w-full'), onclick: () => {
          const name = (prompt('New settings name:', 'my-categories') || '').trim();
          if (!name) return;
          try {
            sstore.putSettingsText(name, serializeSettings(emptySettings(name)));
            reloadSettingsList();
            void selectSettings(name);
            draft = null;
          } catch (e) {
            toast(String((e as Error).message ?? e), 'err');
          }
        },
      }, Ic(FilePlus, 'size-3.5'), 'New'),
      h('button', {
        class: cx(C.btn, 'w-full'), onclick: () => {
          const name = (prompt('Save a copy as:', `${d.name}-copy`) || '').trim();
          if (!name) return;
          try {
            sstore.putSettingsText(name, serializeSettings({ ...d, name }));
            reloadSettingsList();
            void selectSettings(name);
            draft = null;
            toast(`Duplicated as "${name}"`);
          } catch (e) {
            toast(String((e as Error).message ?? e), 'err');
          }
        },
      }, Ic(Copy, 'size-3.5'), 'Duplicate'),
      h('button', { class: cx(C.btn, 'w-full'), onclick: () => importInput.click() }, Ic(FolderInput, 'size-3.5'), 'Import JSON'),
      h('button', {
        class: cx(C.btn, 'w-full'), onclick: () => {
          downloadText(`${d.name}.json`, serializeSettings(d));
        },
      }, Ic(FolderOutput, 'size-3.5'), 'Export JSON'),
      h('button', {
        class: cx(C.btn, 'w-full'), title: 'copy this settings bundle into "default"', onclick: () => {
          try {
            sstore.setDefault(d.name);
            reloadSettingsList();
            toast(`"${d.name}" is now the default settings file`);
            emit();
          } catch (e) {
            toast(String((e as Error).message ?? e), 'err');
          }
        },
      }, Ic(Star, 'size-3.5'), 'Set as default'),
      h('button', {
        class: cx(C.btnDanger, 'w-full'), onclick: () => {
          if (d.name === 'default') { toast('The default settings file cannot be deleted', 'err'); return; }
          if (!confirm(`Delete settings "${d.name}"?`)) return;
          try {
            sstore.deleteSettings(d.name);
          } catch (e) {
            toast(String((e as Error).message ?? e), 'err');
            return;
          }
          reloadSettingsList();
          draft = null;
          loadActiveSettings();
          emit();
        },
      }, Ic(Trash2, 'size-3.5'), 'Delete'),
      importInput,
    ),
  );
}

// ---------- main editor ----------

function editor(d: Settings, report: ConflictReport): HTMLElement {
  const wrap = h('div', { class: 'min-w-0' });

  const saveBtn = h('button', {
    class: cx(C.btnPrimary, dirty && C.btnPulse),
    onclick: () => {
      try {
        sstore.putSettingsText(d.name, serializeSettings(d));
        state.settings = structuredClone(d);
        state.activeSettingsName = d.name;
        sstore.setActiveName(d.name);
        reloadSettingsList();
        dirty = false;
        toast(`Saved "${d.name}"`);
        emit();
      } catch (e) {
        toast(`Save failed: ${(e as Error).message}`, 'err');
      }
    },
  }, Ic(Save, 'size-3.5'), dirty ? 'Save *' : 'Save');

  wrap.appendChild(h('div', { class: 'mb-3 flex flex-wrap items-center gap-3' },
    h('h3', { class: 'flex items-center gap-1.5 text-[15px] font-semibold' }, Ic(Pencil, 'size-4'), 'Editing: ', h('b', { text: d.name })),
    h('span', { class: cx(C.muted, 'text-xs'), text: 'order = priority: a transaction is assigned to the FIRST matching category' }),
    saveBtn,
    h('button', {
      class: C.btn, onclick: () => {
        draft = structuredClone(state.settings);
        openConflict = null; // the draft was replaced wholesale
        dirty = false;
        emit();
      },
    }, Ic(Undo2, 'size-3.5'), 'Discard'),
    h('button', {
      class: C.btn, onclick: () => {
        if (showRaw) { showRaw = false; } else { rawText = serializeSettings(d); rawError = ''; showRaw = true; }
        emit();
      },
    }, Ic(showRaw ? PenLine : Braces, 'size-3.5'), showRaw ? 'Form editor' : 'Raw JSON'),
    h('button', {
      class: C.btn,
      title: 'Colors top categories from the palette and gives every sub-category a lighter shade of its parent',
      onclick: () => {
        autoColorize(d);
        markDirty();
        emit();
        toast('Colors assigned — sub-categories follow their parent');
      },
    }, Ic(Palette, 'size-3.5'), 'Auto Colorize'),
    h('button', {
      class: C.btn,
      title: 'Build a prompt you can paste into an AI chat so it writes the categories for you',
      onclick: () => openAiPromptDialog(d, state.txs),
    }, Ic(Sparkles, 'size-3.5'), 'Let AI write the categories'),
  ));

  if (showRaw) {
    wrap.appendChild(rawEditor(d));
    return wrap;
  }

  if (d.categories.length === 0) {
    wrap.appendChild(h('div', { class: cx(C.muted, 'flex items-center gap-2 border border-dashed border-border p-4') },
      Ic(Inbox, 'size-5'), 'No categories yet. Add one below, or edit the raw JSON.',
    ));
  }

  d.categories.forEach((cat, i) => {
    wrap.appendChild(categoryCard(d, cat, i, report));
  });

  wrap.appendChild(h('button', {
    class: C.btn, onclick: () => {
      d.categories.push({
        tag: `New category ${d.categories.length + 1}`,
        tagFather: null,
        color: colorFor(d.categories.length),
        ibans: [],
        rules: [],
        dateFrom: null,
        dateTo: null,
        enabled: true,
        cashMovement: null,
      });
      markDirty();
      emit();
    },
  }, Ic(Plus, 'size-4'), 'Add category'));
  return wrap;
}

function rawEditor(d: Settings): HTMLElement {
  const ta = h('textarea', { class: 'min-h-[420px] border border-border bg-card px-2.5 py-2 font-mono text-[12.5px] leading-[1.5] text-foreground outline-none focus:border-primary', attrs: { spellcheck: 'false' } }) as HTMLTextAreaElement;
  ta.value = rawText;
  ta.oninput = () => { rawText = ta.value; markDirty(); };
  const err = h('div', { class: cx('flex items-center gap-2 border border-danger/40 bg-danger/10 px-3 py-2 text-danger', rawError ? '' : 'hidden') },
    Ic(TriangleAlert, 'size-4 shrink-0'), rawError);
  return h('div', { class: 'flex flex-col gap-2' },
    ta,
    h('div', { class: 'flex gap-2' },
      h('button', {
        class: C.btnPrimary, onclick: () => {
          try {
            const parsed = parseSettings(rawText, d.name);
            draft = { ...parsed, name: d.name };
            openConflict = null; // the cards were replaced wholesale
            rawError = '';
            markDirty();
            toast('Raw JSON applied');
            emit();
          } catch (e) {
            rawError = (e as Error).message;
            emit();
          }
        },
      }, Ic(Check, 'size-3.5'), 'Apply JSON to editor'),
      h('button', {
        class: C.btn, onclick: () => {
          const content = sstore.getSettingsText(d.name);
          if (content == null) { toast(`settings "${d.name}" not found`, 'err'); return; }
          rawText = content;
          rawError = '';
          emit();
        },
      }, Ic(RefreshCw, 'size-3.5'), 'Reload from saved settings'),
    ),
    err,
  );
}

function categoryCard(
  d: Settings,
  cat: Category,
  i: number,
  report: ConflictReport,
): HTMLElement {
  const audit = report.audits[i];
  const p = report.preview.get(cat.tag) ?? { count: 0, debit: 0, credit: 0 };

  // header controls
  const color = h('input', { class: 'size-7 shrink-0 cursor-pointer border border-border bg-card p-0.5', attrs: { type: 'color', value: cat.color, title: 'color' } }) as HTMLInputElement;
  color.oninput = () => { cat.color = color.value; markDirty(); };

  const tag = h('input', { class: cx(C.input, 'w-[190px] shrink-0 font-semibold'), dataset: { fk: `tag-${i}` }, attrs: { type: 'text', value: cat.tag, 'aria-label': 'tag' } }) as HTMLInputElement;
  // Commit on blur so the previous tag is still available to update children.
  tag.oninput = () => { markDirty(); };
  const renameTag = () => {
    const newTag = tag.value.trim() || cat.tag;
    const oldTag = cat.tag;
    if (newTag !== oldTag) {
      for (const c of d.categories) if (c.tagFather === oldTag) c.tagFather = newTag;
      cat.tag = newTag;
    }
    markDirty();
    emit();
  };
  tag.addEventListener('blur', renameTag);

  const fatherSel = h('select', { class: cx(C.input, 'max-w-[180px]'), attrs: { title: 'parent category' } },
    h('option', { text: '— no parent —', attrs: { value: '' } }),
    ...d.categories.filter((c) => c !== cat).map((c) => h('option', { text: c.tag, attrs: { value: c.tag } })),
  ) as HTMLSelectElement;
  fatherSel.value = cat.tagFather ?? '';
  fatherSel.onchange = () => {
    cat.tagFather = fatherSel.value === '' ? null : fatherSel.value;
    markDirty();
    emit();
  };

  const enabledCb = h('input', { attrs: { type: 'checkbox', checked: cat.enabled ? 'checked' : null } }) as HTMLInputElement;
  enabledCb.checked = cat.enabled;
  enabledCb.onchange = () => { cat.enabled = enabledCb.checked; markDirty(); emit(); };
  const enabled = h('label', { class: cx(C.chipBase, C.chipSm, cat.enabled ? C.chipOn : C.chipOff) }, enabledCb, 'enabled');

  const cashMovementSel = h('select', { class: cx(C.input, 'max-w-[190px]'), attrs: { title: 'cash transfers update the cash balance but are excluded from Spending totals by default — on the Spending page their row keeps a badge that can still count them' } },
    h('option', { text: 'Not a cash transfer', attrs: { value: '' } }),
    h('option', { text: 'Cash withdrawal', attrs: { value: 'withdrawal' } }),
    h('option', { text: 'Cash deposit', attrs: { value: 'deposit' } }),
  ) as HTMLSelectElement;
  cashMovementSel.value = cat.cashMovement ?? '';
  cashMovementSel.onchange = () => { cat.cashMovement = cashMovementSel.value === 'withdrawal' || cashMovementSel.value === 'deposit' ? cashMovementSel.value : null; markDirty(); emit(); };

  const previewBadge = h('span', {
    class: 'bg-muted px-2.5 py-1 text-[11.5px] text-muted-foreground',
    title: 'assignments over loaded transactions (own rules only)',
    text: state.txs.length ? `${p.count} tx · out ${num2(p.debit)} · in ${num2(p.credit)}` : 'load a CSV to preview',
  });

  // what the priority order takes away from this category. Amber, not red: losing
  // rows upward is often intentional (a catch-all parent), and without this the
  // only hint is a count that looks as broken as an unwired rule's zero does.
  const hidden = hiddenRows(audit);
  /** this card owns the open conflict panel (the category, or one rule of it) */
  const openFor = openConflict && openConflict.catIndex === i ? openConflict : null;
  const shadowChip = hidden > 0
    ? h('button', {
      class: cx(C.chipWarn, 'inline-flex cursor-pointer items-center gap-1 hover:bg-warning/20', isDead(audit) && 'font-semibold'),
      title: `${shadowNote(audit)} Click to list the transactions.`,
      onclick: () => toggleConflict(i, null),
    }, Ic(openFor !== null && openFor.ruleIndex === null ? ChevronDown : ChevronRight, 'size-3'), h('span', { text: shadowLabel(audit) }))
    : null;

  const mv = (dir: number) => {
    const j = i + dir;
    if (j < 0 || j >= d.categories.length) return;
    [d.categories[i], d.categories[j]] = [d.categories[j], d.categories[i]];
    // the panel follows the category you moved, so you watch the conflict shrink
    if (openConflict && openConflict.catIndex === i) openConflict = { ...openConflict, catIndex: j };
    else if (openConflict && openConflict.catIndex === j) openConflict = { ...openConflict, catIndex: i };
    markDirty();
    emit();
  };

  // ---- rule editor ----
  const rulesBox = h('div', { class: 'flex flex-col gap-1.5' });
  const owners = report.ruleOwner[i];
  cat.rules.forEach((r, ri) => {
    const owner: number | undefined = owners[ri];
    // an identical rule (same text AND same flags) above this category already
    // decides every row it would match; a copy inside the same category decides
    // nothing either, since one hit is enough for the whole category
    const dupNote = owner == null || owner < 0 ? ''
      : owner === i
        ? 'duplicate of another rule in this category — one matching tag is enough, so this line changes nothing'
        : `same rule as #${owner + 1} ${d.categories[owner].tag}, which has higher priority — it already matches everything this line would, so this copy can be removed`;
    rulesBox.appendChild(ruleRow(cat, r, () => { markDirty(); emit(); }, ri, `rule-${i}-${ri}`, dupNote, () => toggleConflict(i, ri)));
  });
  const addText = h('input', { class: cx(C.input, 'min-w-[120px] flex-1'), dataset: { fk: `ruleadd-${i}` }, attrs: { type: 'text', placeholder: 'add search text…', 'aria-label': 'new rule text' } }) as HTMLInputElement;
  const addRule = (t: string) => {
    const trimmed = t.trim();
    if (!trimmed) return;
    cat.rules.push({ text: trimmed, caseSensitive: false, fuzzy: false, regex: false });
    markDirty();
    emit();
  };
  addText.onkeydown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') { addRule(addText.value); addText.value = ''; }
  };
  rulesBox.appendChild(h('div', { class: 'mt-1 flex flex-wrap items-center gap-1.5' },
    addText,
    h('button', { class: cx(C.btn, C.btnSm), onclick: () => { addRule(addText.value); addText.value = ''; } }, Ic(Plus, 'size-3.5'), 'rule'),
    h('span', { class: cx(C.muted, 'text-[11px]'), text: 'plain text = case-insensitive contains · toggles: Aa = case-sensitive, ≈ fuzzy, .* regex' }),
  ));

  // ---- IBAN editor ----
  const ibanTa = h('textarea', {
    class: 'resize-y border border-border bg-card px-2.5 py-1.5 font-mono text-xs text-foreground outline-none focus:border-primary',
    dataset: { fk: `iban-${i}` },
    attrs: { rows: '2', placeholder: 'one IBAN per line (leave empty = any account)' },
  }) as HTMLTextAreaElement;
  ibanTa.value = cat.ibans.join('\n');
  ibanTa.oninput = () => {
    cat.ibans = ibanTa.value.split(/[\n,]/).map((s) => s.replace(/\s+/g, '').toUpperCase()).filter((s) => s !== '');
    markDirty();
  };
  const uniqueIbans = Array.from(new Set(state.txs.map((t) => t.iban))).slice(0, 8);
  const ibanSuggest = h('div', { class: 'flex flex-wrap gap-1' },
    ...uniqueIbans.map((ib) => h('button', {
      class: cx(C.chipBase, C.chipSm, C.chipNeutral, 'font-mono'), title: 'add to this category', onclick: () => {
        if (!cat.ibans.includes(ib)) cat.ibans.push(ib);
        ibanTa.value = cat.ibans.join('\n');
        markDirty();
        emit();
      },
    }, Ic(Plus, 'size-3'), ib)));

  // ---- date range ----
  const fromIn = h('input', { class: C.input, attrs: { type: 'date', value: cat.dateFrom ?? '', title: 'only count transactions from this date' } }) as HTMLInputElement;
  const toIn = h('input', { class: C.input, attrs: { type: 'date', value: cat.dateTo ?? '', title: 'only count transactions up to this date' } }) as HTMLInputElement;
  fromIn.onchange = () => { cat.dateFrom = fromIn.value || null; markDirty(); emit(); };
  toIn.onchange = () => { cat.dateTo = toIn.value || null; markDirty(); emit(); };

  const card = h('div', { class: cx(C.card, 'mb-2.5 p-3.5', !cat.enabled && 'opacity-60'), dataset: { cat: String(i) } },
    h('div', { class: 'flex flex-wrap items-center gap-2' },
      h('span', { class: 'grid size-[22px] shrink-0 place-items-center bg-muted text-[11px] font-bold text-muted-foreground', title: 'priority (order)', text: String(i + 1) }),
      color, tag,
      h('span', { class: C.label, text: 'under' }), fatherSel,
      enabled, h('span', { class: C.label, text: 'Cash movement' }), cashMovementSel,
      previewBadge,
      shadowChip,
      h('span', { class: 'flex-1' }),
      h('button', { class: cx(C.btn, 'px-2 py-1'), title: 'higher priority', onclick: () => mv(-1) }, Ic(ArrowUp, 'size-3.5')),
      h('button', { class: cx(C.btn, 'px-2 py-1'), title: 'lower priority', onclick: () => mv(1) }, Ic(ArrowDown, 'size-3.5')),
      h('button', {
        class: cx(C.btnDanger, 'px-2 py-1'), title: 'remove category', onclick: () => {
          d.categories.splice(i, 1);
          openConflict = null; // every card after the removed one shifted index
          markDirty();
          emit();
        },
      }, Ic(Trash2, 'size-3.5')),
    ),
    h('div', { class: 'mt-2.5 grid gap-3.5 lg:grid-cols-[1.2fr_1fr_1fr]' },
      h('div', { class: 'flex flex-col gap-1.5' }, h('label', { class: cx(C.label, 'flex items-center gap-1') }, Ic(Tag, 'size-3.5'), 'search tags'), rulesBox),
      h('div', { class: 'flex flex-col gap-1.5' },
        h('label', { class: cx(C.label, 'flex items-center gap-1') }, Ic(CreditCard, 'size-3.5'), 'IBANs'), ibanTa,
        uniqueIbans.length ? h('div', { class: cx(C.muted, 'text-[11px]'), text: 'click to add:' }) : null, ibanSuggest),
      h('div', { class: 'flex flex-col gap-1.5' },
        h('label', { class: cx(C.label, 'flex items-center gap-1') }, Ic(CalendarDays, 'size-3.5'), 'date range (optional)'),
        h('div', { class: 'flex flex-wrap items-center gap-1.5' }, fromIn, h('span', { text: '→' }), toIn,
          h('button', {
            class: C.link, text: 'clear', onclick: () => { cat.dateFrom = null; cat.dateTo = null; markDirty(); emit(); },
          }))),
    ),
    openFor ? conflictPanel(d, i, openFor.ruleIndex) : null,
  );
  return card;
}

function ruleRow(cat: Category, r: SearchRule, onChange: () => void, ri: number, fk: string, dupNote: string, onOpenDup: () => void): HTMLElement {
  const inp = h('input', { class: cx(C.input, 'min-w-20 flex-1', dupNote && 'border-warning/60'), title: dupNote || undefined, dataset: { fk }, attrs: { type: 'text', value: r.text } }) as HTMLInputElement;
  inp.oninput = () => { r.text = inp.value; markDirty(); }; // no re-render while typing
  const toggle = (label: string, on: boolean, title: string, key: 'caseSensitive' | 'fuzzy' | 'regex') =>
    h('button', {
      class: cx(C.togBase, on ? C.togOn : C.togOff),
      text: label,
      title,
      onclick: () => { r[key] = !r[key]; if (key === 'regex' && r.regex) r.fuzzy = false; onChange(); },
    });
  // fixed-width slot so the rule inputs stay aligned whether flagged or not
  const mark = !dupNote
    ? h('span', { class: 'size-4 shrink-0' })
    : h('button', {
      class: 'grid size-4 shrink-0 cursor-pointer place-items-center border-0 bg-transparent p-0 text-warning hover:opacity-70',
      title: `${dupNote} Click to list the transactions.`,
      onclick: onOpenDup,
    }, Ic(TriangleAlert, 'size-3'));
  return h('div', { class: 'flex items-center gap-1.5' },
    mark,
    inp,
    toggle('Aa', r.caseSensitive, 'case sensitive', 'caseSensitive'),
    toggle('≈', r.fuzzy && !r.regex, 'fuzzy (characters in order)', 'fuzzy'),
    toggle('.*', r.regex, 'regular expression', 'regex'),
    h('button', {
      class: cx(C.btnDanger, 'px-2 py-1'), title: 'remove rule', onclick: () => {
        cat.rules.splice(ri, 1);
        onChange();
      },
    }, Ic(X, 'size-3.5')),
  );
}
