import { h, toast } from './util';

/**
 * Click behavior shared by the CSV and the Spending tables:
 *
 * - **single click** on a cell selects exactly the text of that one cell, so
 *   Ctrl+C copies one value (and you immediately see what you picked up);
 * - **double click** (CSV table only, when a column-label function is given)
 *   marks the whole column and selects an off-screen buffer holding every
 *   value of it, one per line — handy for pasting a column into Excel.
 *
 * Clicks on controls inside a cell (checkboxes, category chips, the ▸ toggle)
 * keep their own meaning, and a hand-made text selection is never stolen.
 */

let colBuf: HTMLElement | null = null;

/** drop the marked column and its copy buffer */
export function clearColumnSelect(): void {
  if (colBuf) {
    colBuf.remove();
    colBuf = null;
  }
  document.querySelectorAll('td.col-sel').forEach((td) => td.classList.remove('col-sel'));
}

/** is the selection currently the off-screen column buffer? */
function bufferSelected(): boolean {
  const sel = window.getSelection();
  return !!colBuf && !!sel && sel.containsNode(colBuf, true);
}

/** the cell a click should act on, or null when the click belongs to a control */
function cellUnderClick(e: Event, tbody: HTMLElement): HTMLElement | null {
  const target = e.target as HTMLElement;
  if (target.closest('button,input,select,label,a')) return null;
  const td = target.closest('td');
  return td && tbody.contains(td) ? td : null;
}

export function attachCellSelect(tbody: HTMLElement, columnCopyLabel?: (ci: number) => string): void {
  tbody.addEventListener('click', (e) => {
    const pe = e as PointerEvent;
    if (pe.detail > 1) return; // the second click of a double-click belongs to the column action
    if (pe.pointerType && pe.pointerType !== 'mouse') return; // touch/pen taps must not trigger this
    const td = cellUnderClick(e, tbody);
    if (!td) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && !bufferSelected()) return; // user is selecting text by hand
    if (bufferSelected()) {
      sel?.removeAllRanges(); // a click clears a marked column
      clearColumnSelect();
    }
    const range = document.createRange();
    range.selectNodeContents(td); // select this cell only
    sel?.removeAllRanges();
    sel?.addRange(range);
  });

  if (!columnCopyLabel) return;
  tbody.addEventListener('dblclick', (e) => {
    const pe = e as PointerEvent;
    if (pe.pointerType && pe.pointerType !== 'mouse') return;
    const td = cellUnderClick(e, tbody);
    if (!td) return;
    clearColumnSelect();
    const ci = Array.prototype.indexOf.call(td.parentElement?.children ?? [], td);
    const cells = Array.from(tbody.querySelectorAll('tr'))
      .map((tr) => tr.children[ci] as HTMLElement | undefined)
      .filter((c): c is HTMLElement => !!c);
    colBuf = h('div', { style: { position: 'fixed', left: '-9999px', top: '0', whiteSpace: 'pre' } });
    colBuf.textContent = cells.map((c) => c.textContent ?? '').join('\n');
    document.body.appendChild(colBuf);
    cells.forEach((c) => c.classList.add('col-sel'));
    const range = document.createRange();
    range.selectNodeContents(colBuf);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    toast(`${columnCopyLabel(ci)}: ${cells.length} values marked — press Ctrl+C to copy`);
  });
}
