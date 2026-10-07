import { describe, expect, it } from 'vitest';
import type { Priority } from './api.js';
import { dedupeLinks, dropShadowedLinks, hasText, mergePriorities, repeatedLink, sharesLink } from './priorities.js';
import { MAX_PRIORITIES } from './settings.js';

type Row = [uid: string | null, text: string, patch?: Partial<Priority>];

/** A list as the card holds it: positions from 1, each written row with its uid and addedAt, linked to nothing unless patched. */
function list(...rows: Row[]): Priority[] {
  return rows.map(([uid, text, patch], i) => ({
    position: i + 1,
    text,
    done: false,
    uid,
    addedAt: uid == null ? null : 100,
    cardUid: null,
    recurringUid: null,
    categoryUid: null,
    ...patch,
  }));
}

const CARD = { cardUid: 'card00000001' };
const ROUTINE = { recurringUid: 'rcur00000001' };

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

describe('mergePriorities: links', () => {
  it("keeps a stored row's card and recurring priority whatever this device sends, as it does with a base or without", () => {
    const stored = list(['a', 'Report', CARD], ['b', 'Monitor the queue', ROUTINE]);
    // A draft from before the server linked the rows, and one that changed them (no client does).
    const mine = list(['a', 'Report draft'], ['b', 'Monitor the queue', { recurringUid: 'other0000001' }]);
    const expected = list(['a', 'Report draft', CARD], ['b', 'Monitor the queue', ROUTINE]);
    expect(mergePriorities(stored, list(['a', 'Report'], ['b', 'Monitor the queue']), mine)).toEqual(expected);
    expect(mergePriorities(stored, stored, mine)).toEqual(expected);
    // The server holds the rows and the base doesn't: this device's row, with the stored links.
    expect(mergePriorities(stored, [], mine)).toEqual(expected);
  });

  it("takes this device's links on a row the server doesn't hold", () => {
    const mine = list(['a', 'Report', { ...CARD, categoryUid: 'cat000000001' }]);
    expect(mergePriorities([], [], mine)).toEqual(mine);
  });

  it('merges the category like the text: the device that changed it wins', () => {
    const base = list(['a', 'Report'], ['b', 'Email', { categoryUid: 'cat000000001' }]);
    const stored = list(['a', 'Report'], ['b', 'Email', { categoryUid: 'cat000000002' }]);
    const mine = list(['a', 'Report', { categoryUid: 'cat000000003' }], ['b', 'Email', { categoryUid: 'cat000000001' }]);
    expect(mergePriorities(stored, base, mine)).toEqual(
      list(['a', 'Report', { categoryUid: 'cat000000003' }], ['b', 'Email', { categoryUid: 'cat000000002' }]),
    );
  });

  it('brings back a row another device removed when this device changed its category', () => {
    const base = list(['a', 'Report']);
    const mine = list(['a', 'Report', { categoryUid: 'cat000000001' }]);
    expect(mergePriorities([], base, mine)).toEqual(mine);
  });

  it('keeps a row another device removed gone when this device sent only a different card or recurring priority', () => {
    const base = list(['a', 'Report']);
    expect(mergePriorities([], base, list(['a', 'Report', CARD]))).toEqual([]);
    expect(mergePriorities([], base, list(['a', 'Report', ROUTINE]))).toEqual([]);
  });

  it("stores one row where two devices placed the same card: the one the server holds, in this device's place", () => {
    const base = list(['a', 'Report'], FREE);
    const stored = list(['a', 'Report'], ['x', 'Invoices', CARD]);
    const mine = list(['m', 'Pull: invoices', CARD], ['a', 'Report']);
    expect(mergePriorities(stored, base, mine)).toEqual(list(['x', 'Invoices', CARD], ['a', 'Report']));
  });

  it("pairs only rows with no link by text: another device's linked row of the same text stays beside this one's", () => {
    const stored = list(['x', 'Invoices', CARD]);
    expect(mergePriorities(stored, [], list(['m', 'Invoices']))).toEqual(list(['m', 'Invoices'], ['x', 'Invoices', CARD]));
    expect(mergePriorities(list(['x', 'Invoices']), [], list(['m', 'Invoices', ROUTINE]))).toEqual(list(['m', 'Invoices', ROUTINE], ['x', 'Invoices']));
  });

  it('keeps the stored row, at the first place, when a stale edit brings back a row whose card another row now holds', () => {
    // The other device removed row a and placed its card again as row b.
    const base = list(['a', 'Report', CARD], ['c', 'Email']);
    const stored = list(['c', 'Email'], ['b', 'Report', CARD]);
    const mine = list(['a', 'Report v2', CARD], ['c', 'Email']);
    expect(mergePriorities(stored, base, mine)).toEqual(list(['b', 'Report', CARD], ['c', 'Email']));
  });

  it('drops the link of an emptied row whose card a text row holds', () => {
    const stored = list(['a', '', CARD]);
    expect(mergePriorities(stored, stored, list(['a', ''], ['b', 'Report', CARD]))).toEqual(list(['a', ''], ['b', 'Report', CARD]));
  });
});

describe('sharesLink', () => {
  it('matches on a card or a recurring priority both rows hold, never on null or a category', () => {
    const [a, b] = list(['a', 'A', CARD], ['b', 'B', CARD]);
    expect(sharesLink(a!, b!)).toBe(true);
    expect(sharesLink({ cardUid: null, recurringUid: 'rcur00000001' }, { cardUid: 'card00000001', recurringUid: 'rcur00000001' })).toBe(true);
    const [c, d] = list(['c', 'C', { categoryUid: 'cat000000001' }], ['d', 'D', { categoryUid: 'cat000000001' }]);
    expect(sharesLink(c!, d!)).toBe(false);
    expect(sharesLink(a!, { cardUid: 'card00000002', recurringUid: null })).toBe(false);
  });
});

describe('repeatedLink', () => {
  const none = new Set<string>();

  it('is null for a list whose rows link to nothing, or each to its own', () => {
    expect(repeatedLink(list(['a', 'Report'], ['b', 'Report'], ['c', 'Email']), none)).toBeNull();
    expect(repeatedLink(list(['a', 'Report', CARD], ['b', 'Email', ROUTINE], ['c', 'Call', { cardUid: 'card00000002' }]), none)).toBeNull();
  });

  it('names the later row and the link it repeats when one of the two is new to the server', () => {
    const rows = list(['a', 'Report', CARD], ['b', 'Email'], ['c', 'Report again', CARD]);
    expect(repeatedLink(rows, new Set(['a']))).toEqual({ position: 3, field: 'cardUid' });
    expect(repeatedLink(rows, new Set(['c']))).toEqual({ position: 3, field: 'cardUid' });
    expect(repeatedLink(list(['a', 'Queue', ROUTINE], ['b', 'Queue', ROUTINE]), none)).toEqual({ position: 2, field: 'recurringUid' });
  });

  it('leaves a repeat between two rows the server holds to the merge, and an emptied row out', () => {
    expect(repeatedLink(list(['a', 'Report', CARD], ['c', 'Report again', CARD]), new Set(['a', 'c']))).toBeNull();
    expect(repeatedLink(list(['a', '', CARD], ['c', 'Report', CARD]), none)).toBeNull();
    // A text row without a uid is new to the server.
    expect(repeatedLink(list(['a', 'Report', CARD], [null, 'Report again', CARD]), new Set(['a']))).toEqual({ position: 2, field: 'cardUid' });
  });
});

describe('dedupeLinks', () => {
  it('keeps one text row per card and per recurring priority: the stored one, at the first of their places', () => {
    const rows = list(['m', 'Pulled', CARD], ['a', 'Report'], ['x', 'Invoices', CARD], ['q1', 'Queue', ROUTINE], ['q2', 'Queue', ROUTINE]);
    expect(dedupeLinks(rows, new Set(['x', 'a', 'q2'])).map((p) => p.uid)).toEqual(['x', 'a', 'q2']);
    // Neither held: the first stays.
    expect(dedupeLinks(rows, new Set()).map((p) => p.uid)).toEqual(['m', 'a', 'q1']);
  });

  it('leaves rows linked to nothing, and emptied rows, as they are', () => {
    const rows = list(['a', 'Report'], ['b', 'Report'], ['c', '', CARD], ['d', 'Invoices', CARD], FREE);
    expect(dedupeLinks(rows, new Set())).toEqual(rows);
  });
});

describe('dropShadowedLinks', () => {
  it('takes from an emptied row a card or a recurring priority a text row holds, and leaves its category and every other link', () => {
    const rows = list(
      ['a', '', { ...CARD, categoryUid: 'cat000000001' }],
      ['b', ' ', ROUTINE],
      ['c', '', { cardUid: 'card00000002' }],
      ['d', 'Report', CARD],
      ['e', 'Queue', ROUTINE],
    );
    expect(dropShadowedLinks(rows)).toEqual(
      list(['a', '', { categoryUid: 'cat000000001' }], ['b', ' '], ['c', '', { cardUid: 'card00000002' }], ['d', 'Report', CARD], ['e', 'Queue', ROUTINE]),
    );
  });
});
