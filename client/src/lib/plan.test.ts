import { describe, expect, it } from 'vitest';
import { nextWorkDay, planNext, sameItem, textSeed, type PrioritySeed } from './plan';
import { MAX_PRIORITIES } from '../../../shared/settings.js';
import { makePriority } from '../test/fixtures';

const CARD = { cardUid: 'card00000001' };
const ROUTINE = { recurringUid: 'rcur00000001' };

/** A seed with `text`, linked as patched. */
const seed = (text: string, links: Partial<PrioritySeed> = {}): PrioritySeed => ({ ...textSeed(text), ...links });

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
  it('is the same text however it is typed, or a card or recurring priority both hold; a null link matches nothing', () => {
    expect(sameItem(seed('Ship it'), seed(' ship  IT '))).toBe(true);
    expect(sameItem(seed('Ship it', CARD), seed('Invoices', CARD))).toBe(true);
    expect(sameItem(seed('Queue', ROUTINE), seed('Monitor', ROUTINE))).toBe(true);
    expect(sameItem(seed('Ship it'), seed('Invoices'))).toBe(false);
    expect(sameItem(seed('Ship it', CARD), seed('Invoices', { cardUid: 'card00000002' }))).toBe(false);
  });
});

describe('planNext', () => {
  it('adds after what the day holds, skipping text already there and rows never written in', () => {
    const existing = [makePriority(1, '', { uid: null, addedAt: null }), makePriority(2, 'Call the bank'), makePriority(3, 'Ship it')];
    const { rows, added } = planNext(
      existing,
      ['ship  IT', 'Write the report', ' ', 'write the report'].map((t) => seed(t)),
      99,
    );
    expect(added).toBe(1);
    expect(rows.map((p) => [p.position, p.text])).toEqual([
      [1, 'Call the bank'],
      [2, 'Ship it'],
      [3, 'Write the report'],
    ]);
    // The rows already there keep their identity; the new one gets its own, stamped now.
    expect(rows[0]!.uid).toBe(existing[1]!.uid);
    expect(rows[2]).toMatchObject({ done: false, addedAt: 99 });
    expect(rows[2]!.uid).toMatch(/^[0-9a-f]{12}$/);
  });

  it('keeps a cleared row, which still stands for its item, and adds after it', () => {
    const cleared = makePriority(2, ' ', { uid: 'cleared00000' });
    const existing = [makePriority(1, '', { uid: null, addedAt: null }), cleared, makePriority(3, 'Ship it')];
    const { rows, added } = planNext(existing, [seed('Write the report')], 99);
    expect(added).toBe(1);
    expect(rows.map((p) => [p.position, p.text, p.uid])).toEqual([
      [1, ' ', 'cleared00000'],
      [2, 'Ship it', existing[2]!.uid],
      [3, 'Write the report', rows[2]!.uid],
    ]);
    expect(rows[2]!.uid).not.toBe('cleared00000');
  });

  it('stops at the limit of rows a day can hold', () => {
    const full = Array.from({ length: MAX_PRIORITIES - 1 }, (_, i) => makePriority(i + 1, `p${i}`));
    const { rows, added } = planNext(full, [seed('one more'), seed('and another')], 5);
    expect(added).toBe(1);
    expect(rows).toHaveLength(MAX_PRIORITIES);
  });

  it("carries each seed's card, recurring priority and category onto a row of its own", () => {
    // A row from the day before, carried over: a new row for the new day, the same task.
    const source = makePriority(2, 'Invoices', { uid: 'monday000002', ...CARD, categoryUid: 'cafe00000001' });
    const { rows, added } = planNext([], [source, makePriority(3, 'Queue', ROUTINE)], 99);
    expect(added).toBe(2);
    expect(rows[0]).toMatchObject({ position: 1, text: 'Invoices', done: false, addedAt: 99, ...CARD, categoryUid: 'cafe00000001' });
    expect(rows[0]!.uid).not.toBe('monday000002');
    expect(rows[1]).toMatchObject({ position: 2, text: 'Queue', ...ROUTINE });
  });

  it('adds every seed linked to nothing, whatever the rows there are linked to: a null link matches nothing', () => {
    const { rows, added } = planNext(
      [makePriority(1, 'Report', CARD)],
      ['Email', 'Call the bank', 'Pay rent'].map((t) => seed(t)),
      99,
    );
    expect(added).toBe(3);
    expect(rows.map((p) => [p.text, p.cardUid])).toEqual([
      ['Report', CARD.cardUid],
      ['Email', null],
      ['Call the bank', null],
      ['Pay rent', null],
    ]);
  });

  it('skips a seed whose card or recurring priority a row with text or an earlier seed holds, under any text', () => {
    const existing = [makePriority(1, 'Report', CARD)];
    const seeds = [seed('Report again', CARD), seed('Queue', ROUTINE), seed('Queue renamed', ROUTINE)];
    const { rows, added } = planNext(existing, seeds, 99);
    expect(added).toBe(1);
    expect(rows.map((p) => p.text)).toEqual(['Report', 'Queue']);
  });

  it('gives a seed back the cleared row that holds its link, with its uid and addedAt, even on a full list', () => {
    const cleared = makePriority(2, '', { uid: 'cleared00000', addedAt: 50, ...CARD });
    const { rows, added } = planNext([makePriority(1, 'Ship it'), cleared], [seed('Invoices', { ...CARD, categoryUid: 'cafe00000001' })], 99);
    expect(added).toBe(1);
    expect(rows[1]).toEqual({ ...cleared, text: 'Invoices', categoryUid: 'cafe00000001' });
    const full = [...Array.from({ length: MAX_PRIORITIES - 1 }, (_, i) => makePriority(i + 1, `p${i}`)), { ...cleared, position: MAX_PRIORITIES }];
    expect(planNext(full, [seed('Invoices', CARD)], 99).rows.at(-1)).toMatchObject({ text: 'Invoices', uid: 'cleared00000' });
  });

  it('keeps the category of the cleared row it takes back when the seed brings none', () => {
    const cleared = makePriority(1, '', { uid: 'cleared00000', addedAt: 50, ...CARD, categoryUid: 'cafe00000002' });
    expect(planNext([cleared], [seed('Invoices', CARD)], 99).rows).toEqual([{ ...cleared, text: 'Invoices' }]);
  });
});

describe('textSeed', () => {
  it('is a priority typed new: its text, linked to nothing', () => {
    expect(textSeed('Pay rent')).toEqual({ text: 'Pay rent', cardUid: null, recurringUid: null, categoryUid: null });
  });

  it('takes the category it is given, and still no card or recurring priority', () => {
    expect(textSeed('Pay rent', 'cat000000001')).toEqual({ text: 'Pay rent', cardUid: null, recurringUid: null, categoryUid: 'cat000000001' });
  });
});
