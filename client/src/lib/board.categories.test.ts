import { describe, expect, it } from 'vitest';
import { CATEGORY_COLORS, LIMITS } from '../../../shared/api.js';
import { makeBoard, makeCategory } from '../test/fixtures';
import type { Category, CategoryColor } from '../types';
import { activeCategories, categoryForName, categoryNameTaken, categoryOf, nextColor, withCategory, withCategoryPatch, withoutCategory } from './board';

describe('categories', () => {
  /** A category in use per colour given, named after its colour. */
  const inUse = (...colors: CategoryColor[]) => colors.map((color, i) => makeCategory(`cat${String(i).padStart(9, '0')}`, `${color} ${i}`, { color }));
  const removed = (uid: string, name: string, color: CategoryColor) => makeCategory(uid, name, { color, archived: true });

  it('offers the categories in use, in the order they were made, and finds one by uid, removed or not', () => {
    const cats = [makeCategory('a', 'Tickets'), removed('b', 'Admin', 'teal'), makeCategory('c', 'KB')];
    expect(activeCategories(cats).map((c) => c.uid)).toEqual(['a', 'c']);
    expect(categoryOf(cats, 'b')?.name).toBe('Admin');
    expect(categoryOf(cats, 'zzz')).toBeUndefined();
    expect(categoryOf(cats, null)).toBeUndefined();
  });

  describe('nextColor', () => {
    it('hands out an unused colour first, in palette order', () => {
      expect(nextColor([])).toBe('blue');
      expect(nextColor(inUse('blue', 'green'))).toBe('teal');
    });

    it('then the least used one, palette order on a tie: the 9th category is blue again', () => {
      expect(nextColor(inUse(...CATEGORY_COLORS))).toBe('blue');
      expect(nextColor(inUse(...CATEGORY_COLORS, 'blue', 'teal'))).toBe('green');
      expect(nextColor(inUse(...CATEGORY_COLORS, 'blue', 'blue', 'green'))).toBe('teal');
    });

    it('counts only the categories in use', () => {
      expect(nextColor([removed('r', 'Old', 'blue'), ...inUse('teal')])).toBe('blue');
    });
  });

  it('says a name is taken by another category in use, whatever its case or spacing', () => {
    const cats: Category[] = [makeCategory('a', 'Follow ups'), removed('b', 'Admin', 'teal')];
    expect(categoryNameTaken(cats, '  follow   UPS ', null)).toBe(true);
    // Its own name, and a removed category's, are free.
    expect(categoryNameTaken(cats, 'Follow ups', 'a')).toBe(false);
    expect(categoryNameTaken(cats, 'admin', null)).toBe(false);
  });

  describe('categoryForName', () => {
    it('makes a new category under the uid given, named as typed and tidied, in the next colour', () => {
      expect(categoryForName(inUse('blue'), '  Knowledge   base ', 'new000000001')).toEqual({
        uid: 'new000000001',
        send: { uid: 'new000000001', name: 'Knowledge base', color: 'teal' },
      });
      expect(categoryForName([], 'x'.repeat(LIMITS.categoryName + 3), 'new000000001')?.send?.name).toHaveLength(LIMITS.categoryName);
    });

    it('picks the category in use with that name, sending nothing', () => {
      const cats = [makeCategory('a', 'Tickets'), removed('b', 'Tickets', 'teal')];
      expect(categoryForName(cats, 'TICKETS', 'new000000001')).toEqual({ uid: 'a', send: null });
    });

    it('brings a removed category back under its uid, in its own colour while no category in use has it', () => {
      const cats = [removed('old000000001', 'Admin', 'gold'), ...inUse('blue')];
      expect(categoryForName(cats, 'admin', 'new000000001')).toEqual({
        uid: 'old000000001',
        send: { uid: 'old000000001', name: 'admin', color: 'gold' },
      });
    });

    it('brings it back in the next colour when one in use has its colour, and picks the newest of two removed', () => {
      const cats = [removed('old000000001', 'Admin', 'blue'), removed('old000000002', 'Admin', 'teal'), ...inUse('teal')];
      expect(categoryForName(cats, 'Admin', 'new000000001')).toEqual({
        uid: 'old000000002',
        send: { uid: 'old000000002', name: 'Admin', color: 'blue' },
      });
    });

    it('does nothing for a blank name', () => {
      expect(categoryForName(inUse('blue'), ' \t ', 'new000000001')).toBeNull();
    });
  });

  describe('the board as a write shows it', () => {
    const board = { ...makeBoard(), categories: [makeCategory('a', 'Tickets'), removed('b', 'Admin', 'teal')] };

    it('adds a new category after the others, and brings a removed one back in its place', () => {
      expect(withCategory(board, { uid: 'c', name: 'KB', color: 'green' }).categories).toEqual([
        ...board.categories,
        makeCategory('c', 'KB', { color: 'green' }),
      ]);
      expect(withCategory(board, { uid: 'b', name: 'admin', color: 'gold' }).categories).toEqual([
        board.categories[0],
        makeCategory('b', 'admin', { color: 'gold' }),
      ]);
    });

    it('leaves a category in use as it is when its uid comes again, as the server does for a retry', () => {
      expect(withCategory(board, { uid: 'a', name: 'Other', color: 'pink' })).toBe(board);
    });

    it('renames or recolours one, keeping the field left out', () => {
      expect(withCategoryPatch(board, 'a', { name: 'Tix' }).categories[0]).toEqual(makeCategory('a', 'Tix'));
      expect(withCategoryPatch(board, 'a', { color: 'pink' }).categories[0]).toEqual(makeCategory('a', 'Tickets', { color: 'pink' }));
    });

    it('takes one out of use and keeps it', () => {
      expect(withoutCategory(board, 'a').categories).toEqual([makeCategory('a', 'Tickets', { archived: true }), board.categories[1]]);
    });
  });
});
