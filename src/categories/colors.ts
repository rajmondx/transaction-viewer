import type { Settings } from '../types';
import { buildTree, UNCAT, type TreeNode } from './engine';
import { colorFor, lightenHex } from '../ui/util';

/**
 * Colors a whole bundle the way a chart legend should look: every top-level
 * category gets one of the basic palette colors, its sub-categories lighter
 * shades of the same hue — one step brighter per level.
 */
export function autoColorize(settings: Settings): void {
  const roots = buildTree(settings).filter((r) => r.tag !== UNCAT);
  const walk = (node: TreeNode, base: string, depth: number): void => {
    if (node.category) node.category.color = depth === 0 ? base : lightenHex(base, 0.12 * depth);
    node.children.forEach((ch) => walk(ch, base, depth + 1));
  };
  roots.forEach((r, i) => walk(r, colorFor(i), 0));
}
