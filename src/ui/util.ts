import { CircleAlert, CircleCheck, X } from 'lucide';
import type { IconNode } from 'lucide';
import { Ic } from './icons';

type Child = Node | string | number | null | undefined | false | Child[];

/** join truthy class fragments */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((p): p is string => !!p).join(' ');
}

/** shared Tailwind component recipes. Color "states" never stack with the default
 *  color set (conflicting utilities are order-ambiguous); use the variants as
 *  exclusive alternatives, e.g. cx(C.chipBase, on ? C.chipOn : C.chipOff). */
const BTN_LAYOUT = 'inline-flex cursor-pointer items-center justify-center gap-1.5 border px-3 py-1.5 text-[13px] leading-tight transition-colors';
export const C = {
  btn: `${BTN_LAYOUT} border-border bg-card text-foreground hover:border-input`,
  btnPrimary: `${BTN_LAYOUT} border-primary bg-primary text-primary-foreground hover:bg-primary/85`,
  btnDanger: `${BTN_LAYOUT} border-border bg-card text-danger hover:border-danger/50`,
  btnIcon: `${BTN_LAYOUT} px-2 py-1 font-mono`,
  btnSm: `${BTN_LAYOUT} px-2 py-0.5 text-xs`,
  btnPulse: 'ring-2 ring-primary/35',
  link: 'cursor-pointer border-0 bg-transparent px-1 py-0.5 text-xs text-primary underline',
  linkDanger: 'cursor-pointer border-0 bg-transparent px-1 py-0.5 text-xs text-danger underline',
  chipBase: 'inline-flex cursor-pointer items-center gap-1.5 border px-3 py-1 text-[13px] transition-colors select-none',
  chipOn: 'border-primary/40 bg-accent-soft text-primary',
  chipOff: 'border-border bg-card text-foreground opacity-50 line-through',
  chipNeutral: 'border-border bg-card text-foreground',
  chipSm: 'px-2 py-0.5 text-xs',
  togBase: 'cursor-pointer border px-2 py-0.5 font-mono text-xs transition-colors',
  togOn: 'border-primary bg-primary text-primary-foreground',
  togOff: 'border-border bg-card text-muted-foreground hover:border-input',
  input: 'border border-border bg-card px-2.5 py-1.5 text-sm text-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-accent-soft',
  card: 'border border-border bg-card shadow-card',
  muted: 'text-muted-foreground',
  tiny: 'text-[11px]',
  mono: 'font-mono text-xs',
  pos: 'text-success',
  neg: 'text-danger',
  dot: 'inline-block size-2.5 shrink-0',
  label: 'text-[11px] font-semibold tracking-wide text-muted-foreground uppercase',
  scroll: 'overflow-x-auto border border-border bg-card shadow-card',
  th: 'border-b-2 border-border bg-subtle px-2.5 py-2 text-[11.5px] font-medium whitespace-nowrap text-muted-foreground',
  td: 'border-b border-border px-2.5 py-1.5 whitespace-nowrap',
  num: 'text-right tabular-nums',
  badgeMuted: 'bg-muted px-1.5 py-px text-[10px] text-muted-foreground',
  /** soft amber note — something worth knowing, not a broken value (danger is for those) */
  chipWarn: 'border border-warning/30 bg-warning/10 px-1.5 py-px text-[10px] text-warning',
  /** which rule decided a transaction (ok) vs. one that matched but was overruled (bad) */
  chipOk: 'border border-success/40 bg-success/10 px-1.5 py-px text-[10px] text-success',
  chipBad: 'border border-danger/40 bg-danger/10 px-1.5 py-px text-[10px] text-danger',
};


/** Labeled field group: a small caption above a row of controls.
 *  Shared by the CSV filter bar and the Spending toolbar for a consistent grid. */
export function field(caption: string, icon: IconNode | null, ...controls: Array<HTMLElement | string | null>): HTMLElement {
  return h('div', { class: 'flex min-w-0 flex-col gap-1.5' },
    h('span', { class: cx(C.label, 'flex items-center gap-1') }, icon ? Ic(icon, 'size-3.5') : null, caption),
    h('div', { class: 'flex min-w-0 flex-wrap items-center gap-1.5' }, ...controls),
  );
}

export interface Props {
  class?: string;
  text?: string | number;
  title?: string;
  style?: Partial<CSSStyleDeclaration> | string;
  dataset?: Record<string, string>;
  attrs?: Record<string, string | number | boolean | null>;
  onclick?: (e: MouseEvent) => void;
  oninput?: (e: Event) => void;
  onchange?: (e: Event) => void;
  onkeydown?: (e: KeyboardEvent) => void;
}

/** Tiny DOM builder. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...kids: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    if (props.class != null) el.className = props.class;
    if (props.title != null) el.title = props.title;
    if (props.text != null) el.textContent = String(props.text);
    if (props.style != null) {
      if (typeof props.style === 'string') el.setAttribute('style', props.style);
      else Object.assign(el.style, props.style);
    }
    if (props.dataset) for (const [k, v] of Object.entries(props.dataset)) el.dataset[k] = v;
    if (props.attrs)
      for (const [k, v] of Object.entries(props.attrs))
        if (v !== null && v !== false) el.setAttribute(k, String(v));
        else if (v === false) el.removeAttribute(k);
    if (props.onclick) el.addEventListener('click', props.onclick as EventListener);
    if (props.oninput) el.addEventListener('input', props.oninput as EventListener);
    if (props.onchange) el.addEventListener('change', props.onchange as EventListener);
    if (props.onkeydown) el.addEventListener('keydown', props.onkeydown as EventListener);
  }
  append(el, kids);
  return el;
}

function append(el: Node, kids: Child[]): void {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else if (typeof k === 'string' || typeof k === 'number') el.appendChild(document.createTextNode(String(k)));
    else el.appendChild(k);
  }
}

export function clear(el: Node): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

const nf2 = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 });

/** 'CHF 1’234.56' */
export function money(n: number): string {
  return `CHF ${nf2.format(n)}`;
}
export function num2(n: number): string {
  return nf2.format(n);
}
export function num0(n: number): string {
  return nf0.format(n);
}

/** ISO yyyy-mm-dd -> dd.mm.yyyy */
export function dmy(iso: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

/** ISO -> 'Sep 2026' */
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function monthLabel(m: Month): string {
  const [y, mm] = m.split('-');
  return `${MONTH_NAMES[Number(mm) - 1]} ${y}`;
}
export function monthKey(iso: string): Month {
  return iso.slice(0, 7);
}
type Month = string;

export function debounce(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

/**
 * Bottom toast. It hides itself after 5 s, closes on the ✕ button, and can be
 * swiped away to the left or right (also with the mouse) — see #toast in
 * styles.css for the transition that makes that feel smooth.
 */
const TOAST_MS = 5000;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let toastSeq = 0;

function toastEl(): HTMLElement | null {
  return document.getElementById('toast');
}

/** fade/slide out, then hide — a newer toast cancels an already scheduled hide */
function hideToast(dir: number): void {
  const el = toastEl();
  if (!el) return;
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = undefined;
  }
  const seq = ++toastSeq;
  el.style.opacity = '0';
  if (dir !== 0) el.style.transform = `translate(calc(-50% + ${dir * 130}vw), 0)`;
  setTimeout(() => {
    if (seq !== toastSeq) return; // a newer toast took over in the meantime
    // 'inline-flex' must go before 'hidden' is added: in Tailwind's output the
    // display utilities sort alphabetically, so a lingering 'inline-flex' beats
    // 'hidden' and the toast reappears the moment the fade resets the opacity
    el.classList.remove('inline-flex');
    el.classList.add('hidden');
    el.style.opacity = '';
    el.style.transform = 'translateX(-50%)';
  }, 240);
}

/** drag-to-dismiss; wired once on the shared #toast element */
let toastWired = false;
function wireToastDrag(el: HTMLElement): void {
  if (toastWired) return;
  toastWired = true;
  let startX = 0;
  let dx = 0;
  let dragging = false;
  el.addEventListener('pointerdown', (e) => {
    const pe = e as PointerEvent;
    if ((pe.target as HTMLElement).closest('button')) return; // the ✕ keeps its own click
    dragging = true;
    startX = pe.clientX;
    dx = 0;
    if (toastTimer) {
      clearTimeout(toastTimer); // hold it: the toast must not vanish mid-drag
      toastTimer = undefined;
    }
    el.classList.add('toast-drag');
    el.setPointerCapture(pe.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const pe = e as PointerEvent;
    dx = pe.clientX - startX;
    el.style.transform = `translate(calc(-50% + ${dx}px), 0)`;
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('toast-drag');
    if (Math.abs(dx) > 56) {
      hideToast(dx > 0 ? 1 : -1); // swiped away
    } else {
      el.style.transform = 'translateX(-50%)'; // snapped back, auto-hide starts again
      toastTimer = setTimeout(() => {
        toastTimer = undefined;
        hideToast(0);
      }, TOAST_MS);
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

export function toast(msg: string, kind: 'ok' | 'err' = 'ok'): void {
  const el = toastEl();
  if (!el) return;
  wireToastDrag(el);
  const close = h('button', {
    class: 'ml-1 grid shrink-0 cursor-pointer place-items-center border-0 bg-transparent p-0.5 text-inherit opacity-70 hover:opacity-100',
    attrs: { 'aria-label': 'Dismiss message', title: 'Dismiss' },
    onclick: () => hideToast(0),
  }, Ic(X, 'size-3.5'));
  el.replaceChildren(Ic(kind === 'err' ? CircleAlert : CircleCheck, 'size-4 shrink-0'), h('span', { text: msg }), close);
  el.className = cx(
    'fixed bottom-4 left-1/2 z-[120] inline-flex max-w-[80vw] items-center gap-2 px-4 py-2.5 text-[13px] shadow-card',
    kind === 'err' ? 'bg-danger text-primary-foreground' : 'bg-foreground text-background',
  );
  el.style.transform = 'translateX(-50%)';
  el.style.opacity = '';
  toastSeq++; // this toast supersedes any pending hide
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastTimer = undefined;
    hideToast(0);
  }, TOAST_MS);
}

export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = h('a', { attrs: { href: url, download: filename } });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** 32-bit fnv-1a hex hash */
export function fnv1a(s: string): string {
  let hval = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hval ^= s.charCodeAt(i);
    hval = Math.imul(hval, 0x01000193) >>> 0;
  }
  return hval.toString(16).padStart(8, '0');
}

export const PALETTE = [
  '#4f7df9', '#e5793a', '#3aa66b', '#b0549f', '#8a8f98', '#d1495b',
  '#2a9d8f', '#e9c46a', '#6a4c93', '#1d7874', '#c4653a', '#5c7fed',
  '#9b2226', '#007f5f', '#5f0f40', '#0a9396',
];

export function colorFor(i: number): string {
  return PALETTE[i % PALETTE.length];
}

/** #rrggbb -> [h 0..360, s 0..1, l 0..1] */
function hexToHsl(hex: string): [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return [0, 0, 0.5];
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

/** [h 0..360, s 0..1, l 0..1] -> #rrggbb */
function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const seg = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const part = (v: number): string =>
    Math.round(Math.min(255, Math.max(0, (v + m) * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${part(seg[0])}${part(seg[1])}${part(seg[2])}`;
}

/**
 * A text color that stays readable on top of `hex`: white on dark fills, the
 * app's near-black on light ones. Used wherever a category color becomes a
 * background (CSV chips, share bars).
 */
export function readableOn(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((hex ?? '').trim());
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const lin = (v: number): number => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const lum = 0.2126 * lin(((n >> 16) & 255) / 255) + 0.7152 * lin(((n >> 8) & 255) / 255) + 0.0722 * lin((n & 255) / 255);
  return lum > 0.42 ? '#17202b' : '#ffffff';
}

/**
 * A lighter version of a color — how sub-categories differ from their parent.
 * `amount` shifts lightness (0.12 = noticeably brighter, still the same hue).
 */
export function lightenHex(hex: string, amount: number): string {
  const [h, s, l] = hexToHsl(hex);
  return hslToHex(h, s, Math.min(0.9, Math.max(0, l + amount)));
}
