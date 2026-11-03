import { Copy, Download, Info, Sparkles } from 'lucide';
import type { Settings, Tx } from '../types';
import { AI_LINE_LIMIT, buildAiPrompt, simplifyTxs } from '../categories/aiPrompt';
import { C, cx, downloadText, h, toast } from './util';
import { Ic } from './icons';

/**
 * "Let AI write the categories" dialog.
 *
 * The app never calls an AI — it writes a prompt the user pastes into the
 * assistant of their choice. Including the transactions is opt-in and loudly
 * warned about, because that means putting bank data into a third-party chat.
 */

const PREF_KEY = 'banking.aiIncludeCsv';
let includeCsv = (() => {
  try {
    return localStorage.getItem(PREF_KEY) === '1';
  } catch {
    return false;
  }
})();

function remember(v: boolean): void {
  includeCsv = v;
  try {
    localStorage.setItem(PREF_KEY, v ? '1' : '0');
  } catch { /* ignore */ }
}

function overlayEl(card: HTMLElement, close: () => void): HTMLElement {
  const overlay = h('div', {
    class: 'fixed inset-0 z-[110] grid place-items-center bg-black/45 p-3 backdrop-blur-[2px]',
    onclick: (ev: MouseEvent) => {
      if (ev.target === overlay) close();
    },
  }, card);
  return overlay;
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = h('textarea', { class: 'fixed left-[-9999px] top-0', attrs: { 'aria-hidden': 'true' } }) as HTMLTextAreaElement;
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function openAiPromptDialog(settings: Settings, txs: Tx[]): void {
  let overlay: HTMLElement | null = null;

  const close = (): void => {
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
    document.removeEventListener('keydown', onEsc);
  };
  const onEsc = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };

  // ---- prompt text, recomputed whenever the toggle changes ----
  const ta = h('textarea', {
    class: 'min-h-[260px] w-full resize-y border border-border bg-subtle/60 px-2.5 py-2 font-mono text-[12px] leading-[1.5] text-foreground outline-none focus:border-primary',
    attrs: { readonly: '', spellcheck: 'false', 'aria-label': 'AI prompt' },
  }) as HTMLTextAreaElement;
  const stats = h('div', { class: cx(C.muted, C.tiny) });

  const refresh = (): void => {
    const lines = includeCsv && txs.length > 0 ? simplifyTxs(txs) : null;
    ta.value = buildAiPrompt(settings, lines);
    if (!includeCsv) {
      stats.textContent = `${txs.length} transaction${txs.length === 1 ? '' : 's'} stay on this device — add them to the chat yourself, or turn the toggle below on.`;
    } else if (txs.length === 0) {
      stats.textContent = 'No transactions loaded yet — add a CSV first to include them.';
    } else {
      const shown = lines?.length ?? 0;
      stats.textContent =
        txs.length <= AI_LINE_LIMIT
          ? `All ${txs.length} rows go into the prompt (up to ${AI_LINE_LIMIT} rows are passed through unchanged).`
          : `Simplified ${txs.length} rows down to ${shown} (same IBAN + at least 50 % identical text merged, capped at ${AI_LINE_LIMIT}).`;
    }
  };

  // ---- opt-in toggle + a plain note about what sharing means ----
  const cb = h('input', { attrs: { type: 'checkbox' } }) as HTMLInputElement;
  cb.checked = includeCsv;
  const toggle = h('label', { class: cx(C.chipBase, includeCsv ? C.chipOn : C.chipNeutral) }, cb, 'Add CSV into prompt');
  cb.onchange = () => {
    remember(cb.checked);
    toggle.className = cx(C.chipBase, cb.checked ? C.chipOn : C.chipNeutral);
    refresh();
  };
  const note = h('p', { class: cx(C.muted, 'flex items-start gap-1.5 text-[12px]') },
    Ic(Info, 'size-3.5 shrink-0 mt-0.5'),
    h('span', {}, 'Be aware that if you share your CSV / transaction logs with an AI, it might use them for training. At your own discretion.'),
  );

  // ---- how-to ----
  const steps = h('ol', { class: 'ml-4 list-decimal grid gap-1 text-[12.5px] text-muted-foreground' },
    h('li', {}, 'Copy the prompt below and paste it into your AI chat (ChatGPT, Claude, Gemini, a local model — whichever you use).'),
    h('li', {}, 'Add your CSV file, or at least the most important lines of it, to that chat too, so the AI can read real booking texts.'),
    h('li', {}, 'Use the output and paste it here as ', h('b', { class: 'text-foreground', text: 'Raw JSON' }), ' — and don\u2019t forget to ', h('b', { class: 'text-foreground', text: 'Save' }), '.'),
  );

  const copyBtn = h('button', {
    class: C.btnPrimary,
    onclick: async () => {
      const ok = await copyToClipboard(ta.value);
      toast(ok ? 'Prompt copied — paste it into your AI chat' : 'Copy failed — select the text and copy manually', ok ? 'ok' : 'err');
    },
  }, Ic(Copy, 'size-3.5'), 'Copy prompt');

  const card = h('div', {
    class: 'max-h-[88vh] w-full max-w-[720px] overflow-y-auto border border-border bg-card p-4 shadow-card',
  },
    h('div', { class: 'mb-1 flex items-center gap-2' },
      h('h3', { class: 'flex items-center gap-2 text-[15px] font-semibold' }, Ic(Sparkles, 'size-4'), 'Let AI write the categories'),
      h('button', { class: cx(C.btn, 'ml-auto px-2 py-1'), onclick: () => close(), text: '✕', title: 'Close (Esc)' })),
    h('p', { class: cx(C.muted, 'mb-2.5 text-[12.5px]') },
      'This page never sends anything anywhere: it only writes a prompt. You decide what you hand to the AI.'),
    steps,
    h('div', { class: 'mt-3 flex flex-wrap items-center gap-2' }, toggle),
    h('div', { class: 'mt-1.5' }, note),
    h('div', { class: 'mt-2.5 flex flex-col gap-1.5' }, ta, stats),
    h('div', { class: 'mt-3.5 flex flex-wrap items-center gap-2' },
      copyBtn,
      h('button', {
        class: C.btn, onclick: () => {
          downloadText('ai-category-prompt.txt', ta.value, 'text/plain');
        },
      }, Ic(Download, 'size-3.5'), 'Download .txt'),
      h('button', { class: cx(C.btn, 'ml-auto'), onclick: () => close(), text: 'Close' }),
    ),
  );

  refresh();
  overlay = overlayEl(card, close);
  document.body.appendChild(overlay);
  document.addEventListener('keydown', onEsc);
  ta.focus();
}
