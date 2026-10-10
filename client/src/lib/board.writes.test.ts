import { describe, expect, it } from 'vitest';
import { FOLLOW_UPS, makeBoard, makeCard, makeRecurring, QUEUE, T0 } from '../test/fixtures';
import type { BoardCard } from '../types';
import { withItem, withItemPatch, withoutItem } from './board';

describe('the board as a write shows it', () => {
  const follow = { ...FOLLOW_UPS, weekdays: [1, 3, 5] };
  const board = {
    ...makeBoard(
      makeCard('l1', 'L1'),
      makeCard('l2', 'L2', { position: 2 }),
      makeCard('n1', 'N1', { lane: 'next' }),
      makeCard('d1', 'D1', { lane: null, position: 0, listDate: '2026-09-29', listDone: true }),
    ),
    recurring: [QUEUE, follow],
  };
  const lane = (b: typeof board, l: BoardCard['lane']) =>
    b.cards
      .filter((c) => c.lane === l)
      .sort((a, b) => a.position - b.position)
      .map((c) => `${c.uid}:${c.position}`);
  const task = (b: typeof board, uid: string) => b.cards.find((c) => c.uid === uid);

  describe('withItem', () => {
    it('adds a new task in its lane before the task named, or at the end', () => {
      const top = withItem(board, { uid: 'new', title: 'New', categoryUid: 'cafe00000001', lane: 'later', before: 'l1' }, T0);
      expect(lane(top, 'later')).toEqual(['new:1', 'l1:2', 'l2:3']);
      expect(task(top, 'new')).toEqual(makeCard('new', 'New', { position: 1, categoryUid: 'cafe00000001' }));
      expect(lane(withItem(board, { uid: 'new', title: 'New', categoryUid: null, lane: 'next', before: null }, T0), 'next')).toEqual(['n1:1', 'new:2']);
      // A task named in another lane, or none of the board's, means the end.
      expect(lane(withItem(board, { uid: 'new', title: 'New', categoryUid: null, lane: 'later', before: 'n1' }, T0), 'later')).toEqual([
        'l1:1',
        'l2:2',
        'new:3',
      ]);
    });

    it('leaves the board as it is when the uid is held already, as the server does for a retry', () => {
      expect(withItem(board, { uid: 'd1', title: 'Other', categoryUid: null, lane: 'later', before: null }, T0)).toBe(board);
      expect(withItem(board, { uid: QUEUE.uid, title: 'Other', categoryUid: null, lane: 'next', before: null }, T0)).toBe(board);
    });
  });

  describe('withItemPatch', () => {
    it('patches a title, a lane, or a place in the lane, as the server does', () => {
      expect(task(withItemPatch(board, 'l1', { title: 'Better' }), 'l1')).toMatchObject({ title: 'Better', lane: 'later', position: 1 });
      expect(lane(withItemPatch(board, 'l1', { lane: 'next' }), 'next')).toEqual(['n1:1', 'l1:2']);
      expect(lane(withItemPatch(board, 'l2', { before: 'l1' }), 'later')).toEqual(['l2:1', 'l1:2']);
      expect(lane(withItemPatch(board, 'l2', { lane: 'later' }), 'later')).toEqual(['l1:1', 'l2:2']);
      expect(withItemPatch(board, 'gone', { title: 'X' })).toBe(board);
    });

    it('places a task in no lane when one is named, and a reorder alone leaves it in none', () => {
      expect(task(withItemPatch(board, 'd1', { before: null }), 'd1')).toMatchObject({ lane: null, listDone: true });
      expect(task(withItemPatch(board, 'd1', { lane: 'next', before: 'n1' }), 'd1')).toMatchObject({ lane: 'next', position: 1, listDone: true });
    });

    it('patches a note onto a task or a recurring priority, and keeps it when the patch leaves it out', () => {
      const noted = withItemPatch(board, 'l1', { note: 'Ask Kim' });
      expect(task(noted, 'l1')).toMatchObject({ note: 'Ask Kim', lane: 'later', position: 1 });
      expect(task(withItemPatch(noted, 'l1', { title: 'Kept' }), 'l1')?.note).toBe('Ask Kim');
      expect(task(withItemPatch(noted, 'l1', { note: '' }), 'l1')?.note).toBe('');
      expect(withItemPatch(board, follow.uid, { note: 'Acme first' }).recurring[1]).toEqual({ ...follow, note: 'Acme first' });
    });

    it('patches a category onto a task, or off it, and keeps it when the patch leaves it out', () => {
      const tagged = withItemPatch(board, 'l1', { categoryUid: 'cafe00000001' });
      expect(task(tagged, 'l1')).toMatchObject({ categoryUid: 'cafe00000001', lane: 'later', position: 1 });
      expect(task(withItemPatch(tagged, 'l1', { title: 'Kept' }), 'l1')?.categoryUid).toBe('cafe00000001');
      expect(task(withItemPatch(tagged, 'l1', { categoryUid: null }), 'l1')?.categoryUid).toBeNull();
    });

    it('changes the fields sent of a recurring priority, keeps the ones left out, and sets or clears one weekday, in order', () => {
      expect(withItemPatch(board, follow.uid, { title: 'Chase replies' }).recurring).toEqual([QUEUE, { ...follow, title: 'Chase replies' }]);
      expect(withItemPatch(board, follow.uid, { categoryUid: 'cat000000001' }).recurring[1]).toEqual({ ...follow, categoryUid: 'cat000000001' });
      const weekdays = (patch: { day: number; on: boolean }, of = follow) =>
        withItemPatch({ ...board, recurring: [of] }, of.uid, { weekday: patch }).recurring[0]!.weekdays;
      expect(weekdays({ day: 2, on: true })).toEqual([1, 2, 3, 5]);
      expect(weekdays({ day: 3, on: false })).toEqual([1, 5]);
      expect([weekdays({ day: 5, on: true }), weekdays({ day: 7, on: false })]).toEqual([follow.weekdays, follow.weekdays]);
      // The last day stays: the server refuses to clear it.
      expect(weekdays({ day: 4, on: false }, { ...follow, weekdays: [4] })).toEqual([4]);
      const filed = { ...board, recurring: [{ ...QUEUE, categoryUid: 'cat000000001' }] };
      expect(withItemPatch(filed, QUEUE.uid, { categoryUid: null }).recurring[0]).toEqual(QUEUE);
    });

    it("makes a task a recurring priority with its first day set, out of its lane, after the others, with the patch's other fields", () => {
      const made = withItemPatch(board, 'l1', { title: 'Weekly report', note: 'Fridays', weekday: { day: 5, on: true } });
      expect(made.recurring).toEqual([QUEUE, follow, makeRecurring('l1', 'Weekly report', { note: 'Fridays', weekdays: [5] })]);
      expect(lane(made, 'later')).toEqual(['l2:2']);
      expect(task(made, 'l1')).toBeUndefined();
      const tagged = withItemPatch({ ...board, cards: [{ ...board.cards[2]!, categoryUid: 'cafe00000001' }] }, 'n1', { weekday: { day: 1, on: true } });
      expect(tagged).toMatchObject({ cards: [], recurring: [QUEUE, follow, { uid: 'n1', categoryUid: 'cafe00000001', weekdays: [1] }] });
      // A day cleared on a task changes nothing, as the server refuses it.
      expect(withItemPatch(board, 'l1', { weekday: { day: 5, on: false } })).toEqual(board);
      // A task this copy hasn't read (today's row typed since) is made one from the task as shown; the card held wins.
      const shownAs = { title: 'Water the plants', categoryUid: 'cafe00000001', note: 'Both' };
      expect(withItemPatch(board, 'new000000001', { weekday: { day: 6, on: true } }, shownAs).recurring[2]).toEqual(
        makeRecurring('new000000001', 'Water the plants', { categoryUid: 'cafe00000001', note: 'Both', weekdays: [6] }),
      );
      expect(withItemPatch(board, 'l1', { weekday: { day: 6, on: true } }, shownAs).recurring[2]?.title).toBe(task(board, 'l1')!.title);
      expect(withItemPatch(board, 'new000000001', { title: 'X' }, shownAs)).toBe(board);
    });
  });

  it('takes a deleted task or a recurring priority that stopped repeating off', () => {
    expect(withoutItem(board, 'l1').cards.map((c) => c.uid)).toEqual(['l2', 'n1', 'd1']);
    expect(withoutItem(board, QUEUE.uid).recurring).toEqual([follow]);
    expect(withoutItem(board, 'gone00000001')).toEqual(board);
  });
});
