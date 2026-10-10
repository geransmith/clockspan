import { describe, expect, it } from 'vitest';
import { MAX_PRIORITIES } from '../../../shared/settings.js';
import { makePriority, makeRecurring, T0, TODAY } from '../test/fixtures';
import type { Priority } from '../types';
import { emptyRow } from './priorities';
import { acceptOffer, dueRecurring, notOnList, offerPicks, recurringCount, recurringRow, repeatDays, WEEKDAYS } from './recurring';

// TODAY is a Monday.
const QUEUE = makeRecurring('rcur00000001', 'Monitor the queue', { categoryUid: 'cafe00000001', note: 'Tier 2 too.' });
const FOLLOW_UPS = makeRecurring('rcur00000002', 'Follow-ups', { weekdays: [1, 3, 5] });
const SATURDAY = makeRecurring('rcur00000003', 'Water the plants', { weekdays: [6] });
const NONE = new Set<string>();

/** A routine's row on today's list, its box blank in the draft when given ''. */
const routine = (position: number, item = QUEUE, text = item.title, patch: Partial<Priority> = {}) =>
  makePriority(position, text, { uid: item.uid, recurring: true, categoryUid: item.categoryUid, ...patch });

describe('the days', () => {
  it('numbers the days from Monday, each a letter named in full', () => {
    expect(WEEKDAYS.map((d) => [d.day, d.letter, d.name])).toEqual([
      [1, 'M', 'Monday'],
      [2, 'T', 'Tuesday'],
      [3, 'W', 'Wednesday'],
      [4, 'T', 'Thursday'],
      [5, 'F', 'Friday'],
      [6, 'S', 'Saturday'],
      [7, 'S', 'Sunday'],
    ]);
  });

  it('shows three or more days in a row as a span, and the others one by one', () => {
    expect(repeatDays([1, 2, 3, 4, 5])).toBe('Mon–Fri');
    expect(repeatDays([1, 2, 3, 4, 5, 6, 7])).toBe('Mon–Sun');
    expect(repeatDays([1, 3, 5])).toBe('Mon, Wed, Fri');
    expect(repeatDays([6, 7])).toBe('Sat, Sun');
    expect(repeatDays([3])).toBe('Wed');
    expect(repeatDays([1, 2, 3, 5])).toBe('Mon–Wed, Fri');
  });
});

describe('dueRecurring', () => {
  it("offers the items whose weekdays hold the date's, in the order given", () => {
    expect(dueRecurring([FOLLOW_UPS, SATURDAY, QUEUE], TODAY, [], NONE)).toEqual([FOLLOW_UPS, QUEUE]);
    expect(dueRecurring([FOLLOW_UPS, SATURDAY, QUEUE], '2026-09-29', [], NONE)).toEqual([QUEUE]);
    expect(dueRecurring([FOLLOW_UPS, SATURDAY, QUEUE], '2026-10-03', [], NONE)).toEqual([SATURDAY]);
  });

  it('leaves out an item a row of the list is, its box blank in the draft or not', () => {
    expect(dueRecurring([QUEUE, FOLLOW_UPS], TODAY, [routine(1)], NONE)).toEqual([FOLLOW_UPS]);
    expect(dueRecurring([QUEUE, FOLLOW_UPS], TODAY, [routine(1, QUEUE, '')], NONE)).toEqual([FOLLOW_UPS]);
  });

  it("leaves out an item answered today, and matches rows by uid alone: a one-off row of the title doesn't hide it", () => {
    expect(dueRecurring([QUEUE, FOLLOW_UPS], TODAY, [], new Set([QUEUE.uid]))).toEqual([FOLLOW_UPS]);
    expect(dueRecurring([QUEUE], TODAY, [makePriority(1, 'Monitor the queue')], NONE)).toEqual([QUEUE]);
  });
});

describe('notOnList', () => {
  it('leaves out the items a row of the list is, whatever the day or the row says, and keeps the order', () => {
    expect(notOnList([SATURDAY, FOLLOW_UPS, QUEUE], [routine(1, FOLLOW_UPS, 'Retyped'), routine(2, QUEUE, ''), makePriority(3, 'Water the plants')])).toEqual([
      SATURDAY,
    ]);
  });
});

describe('recurringCount', () => {
  it("counts the recurring priorities' rows, a blank draft of one included", () => {
    expect(recurringCount([routine(1), routine(2, FOLLOW_UPS, ''), makePriority(3, 'One-off'), routine(4, SATURDAY, 'Retyped')])).toBe(3);
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
    expect(offerPicks(due, [routine(1, other), makePriority(2, 'One-off')], 2)).toEqual(new Set([QUEUE.uid]));
    expect(offerPicks(due, [routine(1, other), routine(2, makeRecurring('rcur00000005', 'Another'))], 1)).toEqual(new Set());
  });
});

describe('recurringRow', () => {
  it("is the recurring priority itself, new to today, a recurring row showing the item's title, category and note", () => {
    expect(recurringRow(QUEUE, T0)).toEqual({
      text: 'Monitor the queue',
      done: false,
      uid: QUEUE.uid,
      addedAt: T0,
      categoryUid: 'cafe00000001',
      note: 'Tier 2 too.',
      recurring: true,
      archived: false,
      listed: 0,
      earlier: 0,
      logged: 0,
    });
  });
});

describe('acceptOffer', () => {
  const leftover = makePriority(2, 'Review the PR', { uid: 'task00000001', categoryUid: 'cafe00000002' });

  it('puts the leftovers first and the routines after the padded rows, leaving the free rows for one-offs', () => {
    const list = acceptOffer([], 3, [leftover], [QUEUE, FOLLOW_UPS], T0);
    expect(list.map((p) => [p.position, p.text, p.uid, p.recurring])).toEqual([
      [1, 'Review the PR', 'task00000001', false],
      [2, '', null, false],
      [3, '', null, false],
      [4, 'Monitor the queue', QUEUE.uid, true],
      [5, 'Follow-ups', FOLLOW_UPS.uid, true],
    ]);
    expect(list[0]).toMatchObject({ addedAt: T0, categoryUid: 'cafe00000002' });
    expect(list[1]).toEqual(emptyRow(2));
    expect(list[3]).toMatchObject({ addedAt: T0, categoryUid: 'cafe00000001' });
  });

  it('skips a routine a row of the list is already, under any name or with its box blank', () => {
    const rows = [routine(1, QUEUE, 'Queue, renamed'), routine(2, SATURDAY, '')];
    expect(acceptOffer(rows, 1, [], [QUEUE, SATURDAY, FOLLOW_UPS], T0).map((p) => [p.text, p.uid])).toEqual([
      ['Queue, renamed', QUEUE.uid],
      ['', SATURDAY.uid],
      ['Follow-ups', FOLLOW_UPS.uid],
    ]);
  });

  it('puts each leftover in the first free row, so routines added on another device keep their place', () => {
    // Another device added the routines after the padded rows; the server stores only rows with a task.
    const stored = [routine(4), routine(5, FOLLOW_UPS)];
    expect(acceptOffer(stored, 3, [leftover], [], T0).map((p) => [p.position, p.text])).toEqual([
      [1, 'Review the PR'],
      [2, ''],
      [3, ''],
      [4, 'Monitor the queue'],
      [5, 'Follow-ups'],
    ]);
    expect(acceptOffer([makePriority(1, 'Ship it'), emptyRow(2)], 3, [leftover], [], T0).map((p) => [p.position, p.text])).toEqual([
      [1, 'Ship it'],
      [2, 'Review the PR'],
      [3, ''],
    ]);
  });

  it('skips a leftover the list holds already, under any name, and one that does not fit', () => {
    const rows = [makePriority(1, 'Renamed', { uid: leftover.uid })];
    expect(acceptOffer(rows, 1, [leftover], [], T0).map((p) => p.text)).toEqual(['Renamed']);
    const full = Array.from({ length: MAX_PRIORITIES }, (_, i) => makePriority(i + 1, `p${i + 1}`));
    expect(acceptOffer(full, 3, [leftover], [], T0)).toEqual(full);
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
    expect(list.filter((p) => p.recurring).map((p) => p.uid)).toEqual([QUEUE.uid]);
  });
});
