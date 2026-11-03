import { Code2, Heart, Info, Mail, Phone } from 'lucide';
import { C, cx, h } from './util';
import { Ic } from './icons';

/**
 * App footer (offline notice + open source + author/contact + warranty note)
 * — lives outside the tab content in index.html, so it is visible on every
 * page (Spending, CSV, Categories, Help) without each tab re-rendering it.
 *
 * Layout: two columns above 1040px (the `wide` breakpoint) — brand + offline
 * pitch on the left, the three link rows right-aligned on the right — and a
 * full-width, top-bordered disclaimer row underneath. At 1040px and below it
 * stacks to one column, so tablets don't get the link column squeezed by the
 * long GitHub URL.
 */
export function renderAppFooter(el: HTMLElement): void {
  const ext = { target: '_blank', rel: 'noopener noreferrer' };
  const row = 'flex flex-wrap items-center gap-x-1.5 gap-y-1';
  el.replaceChildren(
    h('div', { class: cx(C.card, 'grid gap-x-8 gap-y-1.5 px-5 py-4 text-[12.5px] text-muted-foreground wide:grid-cols-[1fr_auto]') },
      // Brand + what the app is
      h('div', { class: 'flex flex-col gap-1 pb-1 wide:pb-0' },
        h('p', { class: 'flex items-center gap-1.5 text-[13.5px] font-semibold text-foreground' },
          Ic(Heart, 'size-4 shrink-0 text-primary'),
          'Open Source Transaction Viewer'),
        h('p', { class: 'max-w-[54ch] leading-relaxed' },
          'Works offline on your hardware — nothing is ever sent to a server.')),
      // Links, one row each
      h('div', { class: 'grid gap-y-1 wide:justify-items-end wide:text-right' },
        h('p', { class: row },
          Ic(Code2, 'size-3.5 shrink-0'),
          h('span', { text: 'Source code:' }),
          h('a', {
            class: C.link,
            attrs: { href: 'https://github.com/rajmondx/transaction-viewer', ...ext },
            text: 'github.com/rajmondx/transaction-viewer',
          })),
        h('p', { class: row },
          h('span', { text: 'Made by Rajmond Xhaferi · VAT-Nr.' }),
          h('a', {
            class: C.link,
            attrs: { href: 'https://www.uid.admin.ch/Detail.aspx?uid_id=CHE-495.100.582', ...ext },
            text: 'CHE-495.100.582',
          })),
        h('p', { class: row },
          h('span', { text: 'Contact / suggestions:' }),
          Ic(Mail, 'size-3.5 shrink-0'),
          h('a', { class: C.link, attrs: { href: 'mailto:rajmond.xhaferi@gmail.com' }, text: 'rajmond.xhaferi@gmail.com' }),
          Ic(Phone, 'size-3.5 shrink-0'),
          h('a', { class: C.link, attrs: { href: 'tel:0041787900677' }, text: '0041 78 790 06 77' }))),
      // Disclaimer — its own row across the full width
      h('p', { class: 'flex flex-wrap items-center gap-x-1.5 gap-y-1 border-t border-border pt-2.5 text-[11.5px] wide:col-span-2' },
        Ic(Info, 'size-3.5 shrink-0'),
        h('span', { text: 'This software is provided as is, without warranty of any kind, including fitness for a particular purpose.' })),
    ),
  );
}
