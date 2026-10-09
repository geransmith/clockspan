import { describe, expect, it } from 'vitest';
import { nextWorkDay, planNext, sameItem, textSeed } from './plan';
import { emptyRow } from './priorities';
import { MAX_PRIORITIES } from '../../../shared/settings.js';
import { makePriority } from '../test/fixtures';

describe('nextWorkDay', () => {
  it('is the next day, or the next weekday when weekends are off the calendar', () => {
    expect(nextWorkDay('2026-09-24', true)).toBe('2026-09-25'); // Thu → Fri
    expect(nextWorkDay('2026-09-25', true)).toBe('2026-09-26'); // Fri → Sat
    expect(nextWorkDay('2026-09-25', false)).toBe('2026-09-28'); // Fri → Mon
    expect(nextWorkDay('2026-09-26', false)).toBe('2026-09-28'); // Sat → Mon
    expect(nextWorkDay('2026-09-24', false)).toBe('2026-09-25');
  });
});

describe('sameItem', () => {
  const invoices = makePriority(1, 'Invoices', { uid: 'task00000001' });

  it('is the same task by uid, whatever either is called, a blank draft of it included', () => {
    expect(sameItem(invoices, { uid: 'task00000001', text: 'Pay the invoices', categoryUid: null })).toBe(true);
    expect(sameItem({ ...invoices, text: '' }, invoices)).toBe(true);
    expect(sameItem(invoices, { ...invoices, uid: 'task00000002' })).toBe(false);
  });

  it('matches a seed typed new to a row with its text however it is typed, and never to a blank one', () => {
    expect(sameItem(invoices, textSeed(' invoices  '))).toBe(true);
    expect(sameItem(invoices, textSeed('Ship it'))).toBe(false);
    expect(sameItem(emptyRow(1), textSeed(''))).toBe(false);
  });
});

describe('planNext', () => {
  it('adds after what the day holds, skipping text already there and free rows', () => {
    const existing = [emptyRow(1), makePriority(2, 'Call the bank'), makePriority(3, 'Ship it')];
    const { rows, added } = planNext(existing, [textSeed('ship  IT'), textSeed('Write the report'), textSeed(' '), textSeed('write the report')], 99);
    expect(added).toBe(1);
    expect(rows.map((p) => [p.position, p.text])).toEqual([
      [1, 'Call the bank'],
      [2, 'Ship it'],
      [3, 'Write the report'],
    ]);
    // The rows already there keep their task; one typed new gets its own, added now, on no other day.
    expect(rows[0]!.uid).toBe(existing[1]!.uid);
    expect(rows[2]).toMatchObject({ done: false, addedAt: 99, categoryUid: null, recurring: false, archived: false, listed: 0, earlier: 0, logged: 0 });
    expect(rows[2]!.uid).toMatch(/^[0-9a-f]{12}$/);
  });

  it("puts a carried row's own task on the list, in its category, with its counts until the save answers", () => {
    const source = makePriority(2, 'Invoices', { uid: 'task00000001', categoryUid: 'cafe00000001', listed: 2, earlier: 1, logged: 1500, done: false });
    const { rows, added } = planNext([], [source, textSeed('Pay rent', 'cafe00000002')], 99);
    expect(added).toBe(2);
    expect(rows).toEqual([
      makePriority(1, 'Invoices', { uid: 'task00000001', addedAt: 99, categoryUid: 'cafe00000001', listed: 2, earlier: 1, logged: 1500 }),
      makePriority(2, 'Pay rent', { uid: rows[1]!.uid, addedAt: 99, categoryUid: 'cafe00000002', listed: 0 }),
    ]);
  });

  it('skips a task the list holds already, under any name or with its box blank, and one an earlier seed brought', () => {
    const existing = [makePriority(1, '', { uid: 'task00000001' })];
    const seeds = [
      makePriority(5, 'Invoices', { uid: 'task00000001' }),
      makePriority(6, 'Queue', { uid: 'task00000002' }),
      makePriority(7, 'Queue', { uid: 'task00000002' }),
    ];
    const { rows, added } = planNext(existing, seeds, 99);
    expect(added).toBe(1);
    expect(rows.map((p) => [p.text, p.uid])).toEqual([
      ['', 'task00000001'],
      ['Queue', 'task00000002'],
    ]);
  });

  it('brings over two tasks of one name: they are two tasks', () => {
    const seeds = [makePriority(1, 'Email', { uid: 'task00000001' }), makePriority(2, 'Email', { uid: 'task00000002' })];
    expect(planNext([], seeds, 99).added).toBe(2);
  });

  it('stops at the limit of rows a day can hold', () => {
    const full = Array.from({ length: MAX_PRIORITIES - 1 }, (_, i) => makePriority(i + 1, `p${i}`));
    const { rows, added } = planNext(full, [textSeed('one more'), textSeed('and another')], 5);
    expect(added).toBe(1);
    expect(rows).toHaveLength(MAX_PRIORITIES);
  });
});

describe('textSeed', () => {
  it('is a priority typed new: no task yet, its text, and the category given or none', () => {
    expect(textSeed('Pay rent')).toEqual({ uid: null, text: 'Pay rent', categoryUid: null });
    expect(textSeed('Pay rent', 'cat000000001')).toEqual({ uid: null, text: 'Pay rent', categoryUid: 'cat000000001' });
  });
});
