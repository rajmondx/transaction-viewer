import { describe, expect, it } from 'vitest';
import { autoColorize } from '../src/categories/colors';
import { parseSettings } from '../src/categories/schema';
import { PALETTE, lightenHex, readableOn } from '../src/ui/util';

const hexToL = (hex: string): number => {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
};

describe('lightenHex', () => {
  it('makes a color brighter and keeps it a valid hex', () => {
    const out = lightenHex('#2a9d8f', 0.12);
    expect(out).toMatch(/^#[0-9a-f]{6}$/);
    expect(hexToL(out)).toBeGreaterThan(hexToL('#2a9d8f'));
  });
  it('never goes past near-white and survives junk input', () => {
    expect(hexToL(lightenHex('#ffffff', 0.5))).toBeLessThanOrEqual(0.91);
    expect(lightenHex('nope', 0.1)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('readableOn', () => {
  it('picks white for dark fills', () => {
    expect(readableOn('#007f5f')).toBe('#ffffff');
    expect(readableOn('#17202b')).toBe('#ffffff');
    expect(readableOn('#4f7df9')).toBe('#ffffff');
  });
  it('picks the dark ink for pale fills (the Hosting / ÖV problem)', () => {
    expect(readableOn('#e9c46a')).toBe('#17202b');
    expect(readableOn('#bcd0fd')).toBe('#17202b');
    expect(readableOn('#ffffff')).toBe('#17202b');
  });
  it('falls back to white on junk input', () => {
    expect(readableOn('')).toBe('#ffffff');
    expect(readableOn('not-a-color')).toBe('#ffffff');
  });
});

describe('autoColorize', () => {
  const bundle = parseSettings(JSON.stringify({
    name: 'x',
    categories: [
      { tag: 'Housing' },
      { tag: 'Rent', tag_father: 'Housing' },
      { tag: 'Utilities', tag_father: 'Housing' },
      { tag: 'Basement', tag_father: 'Rent' },
      { tag: 'Groceries', search_tag: ['migros'] },
    ],
  }), 'x');

  it('gives top-level categories the palette colors and sub-categories lighter shades', () => {
    autoColorize(bundle);
    const byTag = new Map(bundle.categories.map((c) => [c.tag, c.color]));
    expect(byTag.get('Housing')).toBe(PALETTE[0]);
    expect(byTag.get('Groceries')).toBe(PALETTE[1]);
    // children follow their parent's hue, one step brighter per level
    expect(hexToL(byTag.get('Rent')!)).toBeGreaterThan(hexToL(byTag.get('Housing')!));
    expect(hexToL(byTag.get('Utilities')!)).toBeCloseTo(hexToL(byTag.get('Rent')!), 5);
    expect(hexToL(byTag.get('Basement')!)).toBeGreaterThan(hexToL(byTag.get('Rent')!));
  });

  it('leaves an empty bundle alone', () => {
    const empty = parseSettings('{"name":"x","categories":[]}', 'x');
    autoColorize(empty);
    expect(empty.categories).toHaveLength(0);
  });
});
