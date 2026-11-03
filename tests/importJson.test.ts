import { describe, expect, it } from 'vitest';
import { classifyJson } from '../src/ui/importJson';

/** the dropped-file router only needs to name the kind — the import itself is localStorage work */
describe('classifyJson', () => {
  it('recognizes a category settings bundle', () => {
    expect(classifyJson({ name: 'default', categories: [{ tag: 'Groceries', search_tag: ['migros'] }] })).toBe('settings');
  });
  it('recognizes a bare array of categories', () => {
    expect(classifyJson([{ tag: 'Groceries', search_tag: ['coop'] }, { tag: 'Rent', tag_father: 'Housing' }])).toBe('settings');
  });
  it('recognizes a whole settings store dump', () => {
    expect(classifyJson({ active: 'default', files: { default: { name: 'default', categories: [] } } })).toBe('settings');
  });
  it('recognizes one CSV schema', () => {
    expect(classifyJson({
      name: 'PostFinance',
      columns: { bookingDate: 'Date', text: 'Description', amount: 'Amount' },
    })).toBe('mappers');
  });
  it('recognizes a list of CSV schemas', () => {
    expect(classifyJson([
      { name: 'A', columns: { bookingDate: 'Date', text: 'Text', credit: 'In', debit: 'Out' } },
      { name: 'B', columns: { bookingDate: 'Datum', text: 'Buchungstext' } },
    ])).toBe('mappers');
  });
  it('recognizes a mapper registry export', () => {
    expect(classifyJson({ saved: [{ name: 'A', columns: { bookingDate: 'Date', text: 'Text', amount: 'Amount' } }] })).toBe('mappers');
  });
  it('says unknown for anything else', () => {
    expect(classifyJson({ hello: 'world' })).toBe('unknown');
    expect(classifyJson([1, 2, 3])).toBe('unknown');
    expect(classifyJson('a string')).toBe('unknown');
    expect(classifyJson(null)).toBe('unknown');
    expect(classifyJson({ categories: 'not-a-list' })).toBe('unknown');
  });
  it('prefers settings when a bundle also carries an old mapper key', () => {
    expect(classifyJson({
      name: 'old',
      categories: [{ tag: 'Rent', search_tag: ['miete'] }],
      mapper: { columns: { bookingDate: 'Date', text: 'Text' } },
    })).toBe('settings');
  });
});
