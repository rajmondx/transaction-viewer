import type { IconNode } from 'lucide';

const NS = 'http://www.w3.org/2000/svg';

/** Build an inline SVG element from lucide icon data (inherits color via currentColor). */
export function Ic(nodes: IconNode, cls = 'size-4'): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '24');
  svg.setAttribute('height', '24');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', cls);
  for (const [tag, attrs] of nodes) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== undefined) el.setAttribute(k, String(v));
    }
    svg.appendChild(el);
  }
  return svg;
}
