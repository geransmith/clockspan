import { describe, expect, it } from 'vitest';
import type { Priority } from './api.js';
import { hasText, isFree, mergePriorities } from './priorities.js';
import { MAX_PRIORITIES } from './settings.js';

type Row = [uid: string | null, text: string, patch?: Partial<Priority>];

/** A list as the card holds it: positions from 1, each written row with its uid and addedAt. */
function list(...rows: Row[]): Priority[] {
  return rows.map(([uid, text, patch], i) => ({
    position: i + 1,
    text,
    done: false,
    uid,
    addedAt: uid == null ? null : 100,
    categoryUid: null,
    recurring: false,
    archived: false,
    listed: 0,
    earlier: 0,
    logged: 0,
    ...patch,
  }));
}

/** A row no task is on. */
const FREE: Row = [null, ''];

describe('hasText', () => {
  it('counts a row with only spaces as empty', () => {
    expect([hasText({ text: 'Report' }), hasText({ text: ' \t' }), hasText({ text: '' })]).toEqual([true, false, false]);
  });
});

describe('isFree', () => {
  it('is a row with no task and no text', () => {
    const [free, written, typed] = list(FREE, ['a', 'Report'], [null, 'Typed']);
    expect([isFree(free!), isFree(written!), isFree(typed!)]).toEqual([true, false, false]);
  });
});

describe('mergePriorities', () => {
  it('stores the list as sent when the server still has the base', () => {
    const base = list(['a', 'Report'], FREE, FREE);
    const mine = list(['a', 'Report', { done: true }], ['b', 'Email', { addedAt: 200 }], FREE);
    expect(mergePriorities(base, base, mine)).toEqual(mine);
  });

  it('takes each field this device changed, and keeps each one another device changed', () => {
    const base = list(['a', 'Report'], ['b', 'Email']);
    // The other device ticked the first row and renamed the second.
    const stored = list(['a', 'Report', { done: true }], ['b', 'Email the team']);
    const mine = list(['a', 'Report draft'], ['b', 'Email', { done: true }]);
    expect(mergePriorities(stored, base, mine)).toEqual(list(['a', 'Report draft', { done: true }], ['b', 'Email the team', { done: true }]));
  });

  it("gives a field both devices changed this device's value", () => {
    const base = list(['a', 'Report']);
    expect(mergePriorities(list(['a', 'Report for Kim']), base, list(['a', 'Report for Sam']))).toEqual(list(['a', 'Report for Sam']));
  });

  it('merges the category like the text: the device that changed it wins', () => {
    const base = list(['a', 'Report'], ['b', 'Email', { categoryUid: 'cat000000001' }]);
    const stored = list(['a', 'Report'], ['b', 'Email', { categoryUid: 'cat000000002' }]);
    const mine = list(['a', 'Report', { categoryUid: 'cat000000003' }], ['b', 'Email', { categoryUid: 'cat000000001' }]);
    expect(mergePriorities(stored, base, mine)).toEqual(
      list(['a', 'Report', { categoryUid: 'cat000000003' }], ['b', 'Email', { categoryUid: 'cat000000002' }]),
    );
  });

  it('drops a row this device removed, even one another device ticked meanwhile', () => {
    const base = list(['a', 'Report'], ['b', 'Email'], ['c', 'Invoices']);
    const stored = list(['a', 'Report'], ['b', 'Email', { done: true }], ['c', 'Invoices']);
    expect(mergePriorities(stored, base, list(['a', 'Report'], ['c', 'Invoices']))).toEqual(list(['a', 'Report'], ['c', 'Invoices']));
  });

  it('keeps a row another device removed gone, unless this device changed it', () => {
    const base = list(['a', 'Report'], ['b', 'Email'], ['c', 'Invoices']);
    const mine = list(['a', 'Report'], ['b', 'Email'], ['c', 'Invoices', { done: true }]);
    expect(mergePriorities(list(['a', 'Report']), base, mine)).toEqual(list(['a', 'Report'], ['c', 'Invoices', { done: true }]));
    // A rename is a change too: the row comes back under its new name.
    expect(mergePriorities([], list(['a', 'Report']), list(['a', 'Quarterly report']))).toEqual(list(['a', 'Quarterly report']));
  });

  it('keeps the stored row when both devices put the task on the list since the base', () => {
    // Both took the left-open offer, the other device first, and it ticked the row since: one row for the one task, as stored.
    const stored = list(['a', 'Report', { done: true, addedAt: 300, recurring: true, listed: 3, earlier: 2, logged: 600 }]);
    expect(mergePriorities(stored, [], list(['a', 'Report draft']))).toEqual(stored);
  });

  it('keeps the read-only fields of the stored row whatever this device sends', () => {
    const stored = list(['a', 'Report', { listed: 4, earlier: 1, logged: 1200, archived: true }]);
    const mine = list(['a', 'Report', { done: true, listed: 0, logged: 0, archived: false }]);
    expect(mergePriorities(stored, stored, mine)).toEqual(list(['a', 'Report', { done: true, listed: 4, earlier: 1, logged: 1200, archived: true }]));
  });

  it("puts another device's new rows in this device's free rows", () => {
    const base = list(['a', 'Report'], FREE, FREE);
    const stored = list(['a', 'Report'], ['x', 'Invoices'], ['y', 'Call the bank']);
    expect(mergePriorities(stored, base, base)).toEqual(list(['a', 'Report'], ['x', 'Invoices'], ['y', 'Call the bank']));
  });

  it("adds another device's new rows at the end once no row is free, after this device's own", () => {
    const base = list(['a', 'Report']);
    const stored = list(['a', 'Report'], ['x', 'Invoices'], ['y', 'Call the bank']);
    const merged = mergePriorities(stored, base, list(['a', 'Report'], ['b', 'Email']));
    expect(merged).toEqual(list(['a', 'Report'], ['b', 'Email'], ['x', 'Invoices'], ['y', 'Call the bank']));
  });

  it("follows this device's order, numbering the rows from 1, free rows included", () => {
    const base = list(['a', 'Report'], ['b', 'Email'], ['c', 'Invoices']);
    const merged = mergePriorities(base, base, list(FREE, ['c', 'Invoices'], ['a', 'Report']));
    expect(merged).toEqual(list(FREE, ['c', 'Invoices'], ['a', 'Report']));
  });

  it('keeps two tasks of one text apart: they are two tasks', () => {
    const base = list(FREE, FREE);
    const stored = list(['x', 'Invoices'], FREE);
    const mine = list(['m', 'invoices'], FREE);
    expect(mergePriorities(stored, base, mine)).toEqual(list(['m', 'invoices'], ['x', 'Invoices']));
  });

  it('ticks only rows with text', () => {
    expect(mergePriorities([], [], list(['a', 'Report', { done: true }], [null, '', { done: true }]))).toEqual(list(['a', 'Report', { done: true }], FREE));
  });

  it("goes past the limit with another device's new rows rather than leave any off", () => {
    const own = Array.from({ length: MAX_PRIORITIES - 1 }, (_, i): Row => [`r${i}`, `Row ${i}`]);
    const base = list(...own);
    const mine = list(...own, ['m', 'Mine']);
    const merged = mergePriorities(list(...own, ['x', 'Theirs']), base, mine);
    expect(merged).toEqual(list(...own, ['m', 'Mine'], ['x', 'Theirs']));
    expect(merged).toHaveLength(MAX_PRIORITIES + 1);
  });
});
