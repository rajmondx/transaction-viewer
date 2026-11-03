/**
 * Grab-and-slide horizontal panning for an `overflow-x` scroll container.
 *
 * Press with the mouse and move sideways — the content follows the pointer
 * (touch and pen are left to the browser's native scrolling). The click that
 * ends a real drag is swallowed, so panning never triggers cell selection or
 * a control under the cursor.
 *
 * `listenOn` may differ from the scrolled box (the Spending header box drives
 * the body box), and `only` restricts where a drag may start (the month cells
 * — dragging over a static column must not pan).
 */
export function attachDragPan(
  scrollBox: HTMLElement,
  listenOn?: HTMLElement,
  only?: (t: HTMLElement) => boolean,
): void {
  const box = listenOn ?? scrollBox;
  if (typeof box.addEventListener !== 'function') return; // node test DOM stub has no events
  let swallowNextClick = false;
  box.addEventListener('pointerdown', (e) => {
    const ev = e as PointerEvent;
    if (ev.button !== 0 || ev.pointerType !== 'mouse') return;
    swallowNextClick = false;
    const t = ev.target as HTMLElement;
    if (only && !only(t)) return;
    if (t.closest('input,button,select,label,a')) return; // controls keep their own click
    const startX = ev.clientX;
    const startLeft = scrollBox.scrollLeft;
    let moved = false;
    ev.preventDefault(); // panning must not select text
    const onMove = (me: PointerEvent): void => {
      const dx = me.clientX - startX;
      if (!moved && Math.abs(dx) > 3) {
        moved = true;
        document.body.style.cursor = 'grabbing'; // follows the pointer even outside the box
      }
      if (moved) scrollBox.scrollLeft = startLeft - dx;
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      swallowNextClick = moved; // the click that ends a drag must not select a cell
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
  box.addEventListener('click', (e) => {
    if (!swallowNextClick) return;
    swallowNextClick = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);
}
