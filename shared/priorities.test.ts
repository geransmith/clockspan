import { describe, expect, it } from 'vitest';
import type { Priority } from './api.js';
import { hasText, mergePriorities } from './priorities.js';
import { MAX_PRIORITIES } from './settings.js';

type Row = [uid: string | null, text: string, patch?: Partial<Priority>];

/** A list as the card holds it: positions from 1, each written row with its uid and addedAt. */
function list(...rows: Row[]): Priority[] {
  return rows.map(([uid, text, patch], i) => ({ position: i + 1, text, done: false, uid, addedAt: uid == null ? null : 100, ...patch }));
}

/** A row nothing was ever written in. */
const FREE: Row = [null, ''];

describe('hasText', () => {
  it('counts a row with only spaces as empty', () => {
    expect([hasText({ text: 'Report' }), hasText({ text: ' \t' }), hasText({ text: '' })]).toEqual([true, false, false]);
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

  it('drops a row this device removed, even one another device ticked meanwhile', () => {
    const base = list(['a', 'Report'], ['b', 'Email'], ['c', 'Invoices']);
    const stored = list(['a', 'Report'], ['b', 'Email', { done: true }], ['c', 'Invoices']);
    expect(mergePriorities(stored, base, list(['a', 'Report'], ['c', 'Invoices']))).toEqual(list(['a', 'Report'], ['c', 'Invoices']));
  });

  it('keeps a row another device removed gone, unless this device changed it', () => {
    const base = list(['a', 'Report'], ['b', 'Email'], ['c', 'Invoices']);
    const mine = list(['a', 'Report'], ['b', 'Email'], ['c', 'Invoices', { done: true }]);
    expect(mergePriorities(list(['a', 'Report']), base, mine)).toEqual(list(['a', 'Report'], ['c', 'Invoices', { done: true }]));
  });

  it("takes this device's row whole when the server has its uid and the base doesn't", () => {
    const stored = list(['a', 'Report', { done: true, addedAt: 300 }]);
    expect(mergePriorities(stored, [], list(['a', 'Report draft']))).toEqual(list(['a', 'Report draft']));
  });

  it("puts another device's new rows in this device's first rows never written in, never in an emptied one", () => {
    // Row b was written in and cleared: it still stands for its item, and its sessions point at it.
    const base = list(['a', 'Report'], ['b', ''], FREE, FREE);
    const stored = list(['a', 'Report'], ['b', ''], FREE, FREE, ['x', 'Invoices'], ['y', 'Call the bank']);
    expect(mergePriorities(stored, base, base)).toEqual(list(['a', 'Report'], ['b', ''], ['x', 'Invoices'], ['y', 'Call the bank']));
  });

  it("adds another device's new rows at the end once no row is free, after this device's own", () => {
    const base = list(['a', 'Report']);
    const stored = list(['a', 'Report'], ['x', 'Invoices'], ['y', 'Call the bank']);
    const merged = mergePriorities(stored, base, list(['a', 'Report'], ['b', 'Email']));
    expect(merged).toEqual(list(['a', 'Report'], ['b', 'Email'], ['x', 'Invoices'], ['y', 'Call the bank']));
  });

  it("follows this device's order, numbering the rows from 1", () => {
    const base = list(['a', 'Report'], ['b', 'Email'], ['c', 'Invoices']);
    const merged = mergePriorities(base, base, list(['c', 'Invoices'], ['a', 'Report']));
    expect(merged).toEqual(list(['c', 'Invoices'], ['a', 'Report']));
  });

  it("stores one set where both devices added the same rows since the base: the stored ones, in this device's places", () => {
    // Both took the left-open offer on an empty list, the other device first.
    const base = list(FREE, FREE, FREE);
    const stored = list(['x1', 'Invoices'], ['y1', 'Call the bank'], FREE);
    const mine = list(['y2', 'call  the Bank '], ['x2', 'invoices'], FREE);
    expect(mergePriorities(stored, base, mine)).toEqual(list(['y1', 'Call the bank'], ['x1', 'Invoices'], FREE));
  });

  it('pairs only rows added on both sides, one with one, so two rows of one text on one list stay two', () => {
    const base = list(['a', 'Invoices']);
    const stored = list(['a', 'Invoices'], ['t', 'Email']);
    const mine = list(['a', 'Invoices'], ['m1', 'Invoices'], ['m2', 'Email'], ['m3', 'email']);
    expect(mergePriorities(stored, base, mine)).toEqual(list(['a', 'Invoices'], ['m1', 'Invoices'], ['t', 'Email'], ['m3', 'email']));
  });

  it("pairs no empty rows: another device's emptied row is kept beside this one's", () => {
    const base = list(['a', 'Report']);
    const stored = list(['a', 'Report'], ['t', '']);
    expect(mergePriorities(stored, base, list(['a', 'Report'], ['m', '']))).toEqual(list(['a', 'Report'], ['m', ''], ['t', '']));
  });

  it('ticks only rows with text', () => {
    // The other device emptied the row this device ticked.
    const base = list(['a', 'Report']);
    expect(mergePriorities(list(['a', '  ']), base, list(['a', 'Report', { done: true }]))).toEqual(list(['a', '  ']));
  });

  it("leaves off another device's new rows past the limit, never this device's", () => {
    const own = Array.from({ length: MAX_PRIORITIES - 1 }, (_, i): Row => [`r${i}`, `Row ${i}`]);
    const base = list(...own);
    const mine = list(...own, ['m', 'Mine']);
    const merged = mergePriorities(list(...own, ['x', 'Theirs']), base, mine);
    expect(merged).toEqual(mine);
  });
});
