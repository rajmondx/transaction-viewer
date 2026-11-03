import { h } from './util';

/**
 * One column-resize handle, shared by the CSV and the Spending table:
 * drag the right edge of a header cell to set its width, double-click the
 * handle to give it back its automatic width.
 */
export interface ResizeTarget {
  /** width the column currently occupies in px (measured, so it works for auto columns too) */
  width(): number;
  /** live width while dragging; 0 = back to automatic */
  apply(px: number): void;
  /** drag/reset finished — persist it (and remember that it was a drag, not a click) */
  commit(): void;
  /** smallest allowed width */
  min?: number;
  title?: string;
}

export function colResizeHandle(t: ResizeTarget): HTMLElement {
  const min = t.min ?? 64;
  const el = h('span', {
    class: 'absolute top-0 right-0 z-10 h-full w-3 cursor-col-resize select-none hover:bg-primary/40',
    title: t.title ?? 'drag to resize · double-click for automatic width',
  });
  el.addEventListener('click', (e) => e.stopPropagation()); // a click on the handle must not sort
  el.addEventListener('pointerdown', (e) => {
    const ev = e as PointerEvent;
    ev.preventDefault();
    ev.stopPropagation();
    const startX = ev.clientX;
    const startW = Math.max(min, t.width());
    let moved = false;
    el.setPointerCapture(ev.pointerId);
    const onMove = (me: PointerEvent): void => {
      if (Math.abs(me.clientX - startX) > 2) moved = true;
      t.apply(Math.max(min, startW + me.clientX - startX));
    };
    const onUp = (): void => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      if (moved) t.commit();
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  });
  el.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    t.apply(0); // automatic width again
    t.commit();
  });
  return el;
}
