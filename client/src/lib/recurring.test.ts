import { describe, expect, it } from 'vitest';
import { MAX_PRIORITIES } from '../../../shared/settings.js';
import { makePriority, makeRecurring, T0, TODAY } from '../test/fixtures';
import type { Priority } from '../types';
import { emptyRow } from './priorities';
import { acceptOffer, dueRecurring, notOnList, offerPicks, readAnswered, recurringCount, recurringRow, writeAnswered } from './recurring';

// TODAY is a Monday.
const QUEUE = makeRecurring('rcur00000001', 'Monitor the queue', { categoryUid: 'cafe00000001' });
const FOLLOW_UPS = makeRecurring('rcur00000002', 'Follow-ups', { weekdays: [1, 3, 5] });
const SATURDAY = makeRecurring('rcur00000003', 'Water the plants', { weekdays: [6] });
const NONE = new Set<string>();

/** A routine's row on today's list, with text unless given ''. */
const routine = (position: number, item = QUEUE, text = item.title, patch: Partial<Priority> = {}) =>
  makePriority(position, text, { recurringUid: item.uid, categoryUid: item.categoryUid, ...patch });
const UID = /^[0-9a-f]{12}$/;

describe('dueRecurring', () => {
  it("offers the items whose weekdays hold the date's, in the order given", () => {
    expect(dueRecurring([FOLLOW_UPS, SATURDAY, QUEUE], TODAY, [], NONE)).toEqual([FOLLOW_UPS, QUEUE]);
    expect(dueRecurring([FOLLOW_UPS, SATURDAY, QUEUE], '2026-09-29', [], NONE)).toEqual([QUEUE]);
    expect(dueRecurring([FOLLOW_UPS, SATURDAY, QUEUE], '2026-10-03', [], NONE)).toEqual([SATURDAY]);
  });

  it('leaves out an item a row with text holds, but not one only an emptied row holds', () => {
    expect(dueRecurring([QUEUE, FOLLOW_UPS], TODAY, [routine(1)], NONE)).toEqual([FOLLOW_UPS]);
    expect(dueRecurring([QUEUE, FOLLOW_UPS], TODAY, [routine(1, QUEUE, '')], NONE)).toEqual([QUEUE, FOLLOW_UPS]);
  });

  it("leaves out an item answered today, and matches rows by the link alone: a one-off row of the title, or one linked to nothing, doesn't hide it", () => {
    expect(dueRecurring([QUEUE, FOLLOW_UPS], TODAY, [], new Set([QUEUE.uid]))).toEqual([FOLLOW_UPS]);
    expect(dueRecurring([QUEUE], TODAY, [makePriority(1, 'Monitor the queue')], NONE)).toEqual([QUEUE]);
  });
});

describe('notOnList', () => {
  it('leaves out the items a row with text holds, whatever the day, and keeps the order', () => {
    expect(notOnList([SATURDAY, FOLLOW_UPS, QUEUE], [routine(1, FOLLOW_UPS, 'Retyped'), routine(2, QUEUE, ''), makePriority(3, 'Water the plants')])).toEqual([
      SATURDAY,
      QUEUE,
    ]);
  });
});

describe('recurringCount', () => {
  it('counts the rows with text that came from a recurring priority', () => {
    expect(recurringCount([routine(1), routine(2, FOLLOW_UPS, ''), makePriority(3, 'One-off'), routine(4, SATURDAY, 'Retyped')])).toBe(2);
  });
});

describe('offerPicks', () => {
  const due = [QUEUE, FOLLOW_UPS, SATURDAY];

  it('ticks the first ones in order, up to the number a day', () => {
    expect(offerPicks(due, [], 2)).toEqual(new Set([QUEUE.uid, FOLLOW_UPS.uid]));
    expect(offerPicks(due, [], 5)).toEqual(new Set(due.map((r) => r.uid)));
  });

  it('counts the routines already on the list, never going below none', () => {
    const other = makeRecurring('rcur00000004', 'Other');
    expect(offerPicks(due, [routine(1, other), makePriority(2, 'One-off'), routine(3, other, '')], 2)).toEqual(new Set([QUEUE.uid]));
    expect(offerPicks(due, [routine(1, other), routine(2, makeRecurring('rcur00000005', 'Another'))], 1)).toEqual(new Set());
  });
});

describe('recurringRow', () => {
  it("is a new row of today with the item's title and category, linked to it and to no card", () => {
    const row = recurringRow(QUEUE, T0);
    expect(row).toEqual({
      text: 'Monitor the queue',
      done: false,
      uid: row.uid,
      addedAt: T0,
      cardUid: null,
      recurringUid: QUEUE.uid,
      categoryUid: 'cafe00000001',
    });
    expect(row.uid).toMatch(UID);
    expect(recurringRow(QUEUE, T0).uid).not.toBe(row.uid);
  });
});

describe('acceptOffer', () => {
  const leftover = { text: 'Review the PR', cardUid: 'card00000001', recurringUid: null, categoryUid: null };

  it('puts the leftovers first and the routines after the padded rows, leaving the free rows for one-offs', () => {
    const list = acceptOffer([], 3, [leftover], [QUEUE, FOLLOW_UPS], T0);
    expect(list.map((p) => [p.position, p.text, p.recurringUid])).toEqual([
      [1, 'Review the PR', null],
      [2, '', null],
      [3, '', null],
      [4, 'Monitor the queue', QUEUE.uid],
      [5, 'Follow-ups', FOLLOW_UPS.uid],
    ]);
    expect(list[0]).toMatchObject({ cardUid: 'card00000001', addedAt: T0 });
    expect(list[1]).toEqual(emptyRow(2));
    expect(list[3]).toMatchObject({ addedAt: T0, categoryUid: 'cafe00000001', cardUid: null });
  });

  it("takes back an emptied routine row, keeping its uid and addedAt, in the item's category or else its own", () => {
    const emptied = routine(2, QUEUE, '', { uid: 'emptied00001', addedAt: 50, categoryUid: 'cafe00000009' });
    const list = acceptOffer([makePriority(1, 'A'), emptied], 3, [], [QUEUE], T0);
    expect(list).toEqual([makePriority(1, 'A'), { ...emptied, text: 'Monitor the queue', categoryUid: 'cafe00000001' }, emptyRow(3)]);
    const plain = routine(1, FOLLOW_UPS, '', { uid: 'emptied00002', addedAt: 50, categoryUid: 'cafe00000009' });
    expect(acceptOffer([plain], 1, [], [FOLLOW_UPS], T0)).toEqual([{ ...plain, text: 'Follow-ups' }]);
  });

  it('skips a routine a row with text already holds', () => {
    const rows = [routine(1, QUEUE, 'Queue, renamed')];
    expect(acceptOffer(rows, 1, [], [QUEUE, FOLLOW_UPS], T0).map((p) => [p.text, p.recurringUid])).toEqual([
      ['Queue, renamed', QUEUE.uid],
      ['Follow-ups', FOLLOW_UPS.uid],
    ]);
  });

  it('brings the leftovers through planNext, which keeps an emptied one-off row ahead of them', () => {
    const emptied = makePriority(2, '', { uid: 'emptied00003' });
    const list = acceptOffer([emptyRow(1), emptied], 3, [leftover], [], T0);
    expect(list.map((p) => [p.position, p.text, p.uid])).toEqual([
      [1, '', 'emptied00003'],
      [2, 'Review the PR', list[1]!.uid],
      [3, '', null],
    ]);
  });

  it('with no leftovers, leaves a free row between written ones where it is', () => {
    const rows = [makePriority(1, 'A'), emptyRow(2), makePriority(3, 'C')];
    expect(acceptOffer(rows, 3, [], [QUEUE], T0).map((p) => [p.position, p.text])).toEqual([
      [1, 'A'],
      [2, ''],
      [3, 'C'],
      [4, 'Monitor the queue'],
    ]);
  });

  it("skips a routine that doesn't fit", () => {
    const full = Array.from({ length: MAX_PRIORITIES - 1 }, (_, i) => makePriority(i + 1, `p${i + 1}`));
    const list = acceptOffer(full, 3, [], [QUEUE, FOLLOW_UPS], T0);
    expect(list).toHaveLength(MAX_PRIORITIES);
    expect(list.map((p) => p.recurringUid).filter((u) => u != null)).toEqual([QUEUE.uid]);
  });
});

describe('readAnswered and writeAnswered', () => {
  it('read back what was written for the same date, each uid once', () => {
    const raw = writeAnswered(TODAY, [QUEUE.uid, FOLLOW_UPS.uid, QUEUE.uid]);
    expect(raw).toBe(`${TODAY} ${QUEUE.uid},${FOLLOW_UPS.uid}`);
    expect(readAnswered(raw, TODAY)).toEqual(new Set([QUEUE.uid, FOLLOW_UPS.uid]));
  });

  it('read nothing for another date, nothing stored, no list or something else', () => {
    expect(readAnswered(writeAnswered(TODAY, [QUEUE.uid]), '2026-09-29')).toEqual(new Set());
    expect(readAnswered(null, TODAY)).toEqual(new Set());
    expect(readAnswered(TODAY, TODAY)).toEqual(new Set());
    expect(readAnswered(writeAnswered(TODAY, []), TODAY)).toEqual(new Set());
    expect(readAnswered(`x${TODAY} ${QUEUE.uid}`, TODAY)).toEqual(new Set());
  });
});
