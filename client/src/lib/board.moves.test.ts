import { describe, expect, it } from 'vitest';
import { FOLLOW_UPS, makeCard, makeDay, makePriority, QUEUE, rowUid } from '../test/fixtures';
import type { BoardCard } from '../types';
import { columnDropId, dropTarget, findItem, moveAnnouncement, moveTargets, overAnnouncement, planMove, withDrag } from './board';
import { BOARD, BOARD_DRAG, DONE_STAYS } from './copy';
import { columns, ids, MON, ROUTINE, THU, TUE, WED } from './board.testkit';

describe('planMove', () => {
  const cards: BoardCard[] = [
    makeCard('later', 'Write a KB', { categoryUid: 'cafe00000003', note: 'Ticket 4821', listed: 2, logged: 600 }),
    makeCard('next', 'Follow up', { lane: 'next' }),
    makeCard('planned', 'Plan B', { lane: 'next', position: 2, listDate: THU }),
    makeCard('doneTue', 'Shipped', { lane: null, listDate: TUE, listDone: true, listed: 1, logged: 1500 }),
    makeCard('carried', 'Carried', { lane: 'next', position: 3, listDate: THU }),
    makeCard('left', 'Left open', { lane: null, listDate: TUE, categoryUid: 'cafe00000002' }),
  ];
  const todayRows = [
    makePriority(1, 'Open', { categoryUid: 'cafe00000001' }),
    makePriority(2, 'Ticked', { done: true }),
    makePriority(3, 'Monitor the queue', ROUTINE),
    makePriority(4, 'Carried', { uid: 'carried' }),
  ];
  const tuesday = makeDay(TUE, {
    priorities: [makePriority(1, 'Follow-ups', { uid: FOLLOW_UPS.uid, recurring: true, done: true, categoryUid: 'cafe00000004', listed: 5, logged: 300 })],
  });
  const routines = [QUEUE, { ...FOLLOW_UPS, categoryUid: 'cafe00000004', note: 'Acme first' }];
  const c = columns({ cards, todayRows, earlierDays: [tuesday], recurring: routines });
  const item = (id: string) => findItem(c, id)!.item;
  const open = item(`item:${rowUid(1)}`);
  const ticked = item(`item:${rowUid(2)}`);
  const recurring = item('item:rcur00000001');
  const carried = item('item:carried');
  const left = item('item:left');
  const routineTicked = item(`row:${TUE}:rcur00000002`);
  // Follow-ups is off today's list: Later's Repeats shows it.
  const repeating = item('item:rcur00000002');

  it('moves a task between Later and Next, or within one, as a patch', () => {
    expect(planMove(item('item:later'), 'next', null, WED)).toEqual({ kind: 'patch', uid: 'later', patch: { lane: 'next', before: null } });
    expect(planMove(item('item:next'), 'later', 'later', WED)).toEqual({ kind: 'patch', uid: 'next', patch: { lane: 'later', before: 'later' } });
    expect(planMove(item('item:next'), 'next', null, WED)).toEqual({ kind: 'patch', uid: 'next', patch: { before: null } });
  });

  it('gives a task left open a place of its own in Next, or in Later', () => {
    expect(planMove(left, 'next', 'next', WED)).toEqual({ kind: 'patch', uid: 'left', patch: { lane: 'next', before: 'next' } });
    expect(planMove(left, 'later', null, WED)).toEqual({ kind: 'patch', uid: 'left', patch: { lane: 'later', before: null } });
  });

  it("sorts nothing for today's row shown in a lane while its park is on its way", () => {
    expect(planMove({ ...open, column: 'later' }, 'later', 'later', WED)).toBeNull();
    expect(planMove({ ...carried, column: 'next' }, 'next', null, WED)).toBeNull();
  });

  it("puts a task of Later or Next on today's list as itself, in its category, with its note and the board's counts: open with the nudge, ticked without", () => {
    expect(planMove(item('item:later'), 'progress', null, WED)).toEqual({
      kind: 'place',
      row: {
        uid: 'later',
        addedAt: null,
        text: 'Write a KB',
        done: false,
        categoryUid: 'cafe00000003',
        note: 'Ticket 4821',
        recurring: false,
        archived: false,
        listed: 2,
        earlier: 0,
        logged: 600,
      },
      nudge: true,
    });
    expect(planMove(item('item:next'), 'done', null, WED)).toMatchObject({ kind: 'place', row: { uid: 'next', text: 'Follow up', done: true }, nudge: false });
    expect(planMove(left, 'progress', null, WED)).toMatchObject({ kind: 'place', row: { uid: 'left', categoryUid: 'cafe00000002' }, nudge: true });
  });

  it('pulls a task done on an earlier day into In Progress, the same task again', () => {
    expect(planMove(item('item:doneTue'), 'progress', null, WED)).toMatchObject({
      kind: 'place',
      row: { uid: 'doneTue', text: 'Shipped', done: false, listed: 1, logged: 1500 },
      nudge: true,
    });
  });

  it("puts an earlier day's routine tick back on today as the same recurring priority, with its note and that row's counts", () => {
    expect(planMove(routineTicked, 'progress', null, WED)).toEqual({
      kind: 'place',
      row: {
        uid: 'rcur00000002',
        addedAt: null,
        text: 'Follow-ups',
        done: false,
        categoryUid: 'cafe00000004',
        note: 'Acme first',
        recurring: true,
        archived: false,
        listed: 5,
        earlier: 0,
        logged: 300,
      },
      nudge: true,
    });
  });

  it("puts a card of Later's Repeats on today's list as the recurring priority, with none of a row's counts: open with the nudge, ticked without", () => {
    expect(planMove(repeating, 'progress', null, WED)).toEqual({
      kind: 'place',
      row: {
        uid: 'rcur00000002',
        addedAt: null,
        text: 'Follow-ups',
        done: false,
        categoryUid: 'cafe00000004',
        note: 'Acme first',
        recurring: true,
        archived: false,
        listed: 0,
        earlier: 0,
        logged: 0,
      },
      nudge: true,
    });
    expect(planMove(repeating, 'done', null, WED)).toMatchObject({ kind: 'place', row: { uid: 'rcur00000002', done: true, recurring: true }, nudge: false });
  });

  it("ticks and unticks today's rows between In Progress and Done", () => {
    expect(planMove(open, 'done', null, WED)).toEqual({ kind: 'tick', uid: rowUid(1), done: true });
    expect(planMove(ticked, 'progress', null, WED)).toEqual({ kind: 'tick', uid: rowUid(2), done: false });
    expect(planMove(recurring, 'done', null, WED)).toEqual({ kind: 'tick', uid: 'rcur00000001', done: true });
  });

  it("parks today's open row in Later or Next", () => {
    expect(planMove(open, 'later', 'later', WED)).toEqual({ kind: 'park', uid: rowUid(1), lane: 'later', before: 'later' });
    expect(planMove(open, 'next', null, WED)).toEqual({ kind: 'park', uid: rowUid(1), lane: 'next', before: null });
  });

  it("moves a task a later day's list holds as any other: today's row of it parks in Later or Next, and a card of it moves and comes onto today's list", () => {
    expect(planMove(carried, 'later', null, WED)).toEqual({ kind: 'park', uid: 'carried', lane: 'later', before: null });
    expect(planMove(carried, 'next', null, WED)).toEqual({ kind: 'park', uid: 'carried', lane: 'next', before: null });
    expect(planMove(item('item:planned'), 'later', null, WED)).toEqual({ kind: 'patch', uid: 'planned', patch: { lane: 'later', before: null } });
    expect(planMove(item('item:planned'), 'progress', null, WED)).toMatchObject({ kind: 'place', row: { uid: 'planned', done: false }, nudge: true });
  });

  it("keeps a done item done: today's ticked row and a task done earlier moved to Later or Next give the notice, with where it was dropped and its category", () => {
    expect(planMove(ticked, 'later', 'later', WED)).toEqual({ kind: 'doneStays', title: 'Ticked', categoryUid: null, lane: 'later', before: 'later' });
    expect(planMove(item('item:doneTue'), 'next', null, WED)).toEqual({ kind: 'doneStays', title: 'Shipped', categoryUid: null, lane: 'next', before: null });
  });

  it("refuses a recurring priority in Later or Next: a row, ticked or not, and its card in Later's Repeats, its own column included", () => {
    expect(planMove(recurring, 'later', null, WED)).toEqual({ kind: 'refuse', message: BOARD.recurringStays('Monitor the queue') });
    expect(planMove(routineTicked, 'next', null, WED)).toEqual({ kind: 'refuse', message: BOARD.recurringStays('Follow-ups') });
    expect(planMove(repeating, 'next', 'next', WED)).toEqual({ kind: 'refuse', message: BOARD.recurringStays('Follow-ups') });
    expect(planMove(repeating, 'later', 'later', WED)).toEqual({ kind: 'refuse', message: BOARD.recurringStays('Follow-ups') });
  });

  it("refuses an earlier day's tick of a recurring priority that stopped repeating on today's list, archived or gone from the board, and still ticks today's row of one", () => {
    const archived = makeDay(TUE, { priorities: [{ ...tuesday.priorities[0]!, archived: true }] });
    const removedToday = makePriority(5, 'Old routine', { uid: 'rcur00000003', recurring: true, archived: true });
    const gone = columns({ cards, todayRows: [removedToday], earlierDays: [tuesday], recurring: [routines[0]!] });
    const stale = columns({ cards, earlierDays: [archived], recurring: routines });
    for (const c of [gone, stale]) {
      const tick = findItem(c, `row:${TUE}:rcur00000002`)!.item;
      expect(planMove(tick, 'progress', null, WED)).toEqual({ kind: 'refuse', message: BOARD.removed('Follow-ups') });
      expect(moveTargets(tick, WED)).toEqual([]);
    }
    const todays = findItem(gone, 'item:rcur00000003')!.item;
    expect(planMove(todays, 'done', null, WED)).toEqual({ kind: 'tick', uid: 'rcur00000003', done: true });
    expect(moveTargets(todays, WED)).toEqual(['done']);
  });

  it('does nothing for a drop where the item already is in In Progress or Done', () => {
    expect(planMove(open, 'progress', null, WED)).toBeNull();
    expect(planMove(ticked, 'done', null, WED)).toBeNull();
    expect(planMove(item('item:doneTue'), 'done', null, WED)).toBeNull();
    expect(planMove(routineTicked, 'done', null, WED)).toBeNull();
  });

  it('offers every other column, Next for a task left open, and no Later or Next for a recurring priority', () => {
    expect(moveTargets(item('item:later'), WED)).toEqual(['next', 'progress', 'done']);
    expect(moveTargets(item('item:planned'), WED)).toEqual(['later', 'progress', 'done']);
    expect(moveTargets(open, WED)).toEqual(['later', 'next', 'done']);
    expect(moveTargets(carried, WED)).toEqual(['later', 'next', 'done']);
    expect(moveTargets(left, WED)).toEqual(['later', 'next', 'progress', 'done']);
    // Done items keep Later and Next, which answer with the notice.
    expect(moveTargets(ticked, WED)).toEqual(['later', 'next', 'progress']);
    expect(moveTargets(item('item:doneTue'), WED)).toEqual(['later', 'next', 'progress']);
    expect(moveTargets(recurring, WED)).toEqual(['done']);
    expect(moveTargets(routineTicked, WED)).toEqual(['progress']);
    expect(moveTargets(repeating, WED)).toEqual(['progress', 'done']);
  });
});

describe('dragging', () => {
  const cards: BoardCard[] = [
    makeCard('a', 'A'),
    makeCard('b', 'B', { position: 2 }),
    makeCard('c', 'C', { position: 3 }),
    makeCard('d', 'D', { lane: 'next' }),
    makeCard('p', 'Plan B', { lane: 'next', position: 2, listDate: THU }),
    makeCard('e', 'Shipped', { lane: null, listDate: TUE, listDone: true }),
    makeCard('carried', 'Carried', { lane: 'next', position: 3, listDate: THU }),
    makeCard('lo1', 'Left open 1', { lane: null, listDate: TUE }),
    makeCard('lo2', 'Left open 2', { lane: null, listDate: MON }),
  ];
  const todayRows = [
    makePriority(1, 'Open'),
    makePriority(2, 'Ticked', { done: true }),
    makePriority(3, 'Monitor the queue', ROUTINE),
    makePriority(4, 'Carried', { uid: 'carried' }),
  ];
  const c = columns({ cards, todayRows });
  const open = `item:${rowUid(1)}`;
  const ticked = `item:${rowUid(2)}`;
  const item = (id: string) => findItem(c, id)!.item;

  it('finds an item and the column showing it, the week of Done included', () => {
    expect(ids(c).next).toEqual(['item:d', 'item:p', 'item:lo1', 'item:lo2']);
    expect(findItem(c, 'item:b')).toEqual({ item: c.later[1], column: 'later' });
    expect(findItem(c, 'item:e')).toEqual({ item: c.doneEarlier[0], column: 'done' });
    expect(findItem(c, ticked)).toEqual({ item: c.doneToday[0], column: 'done' });
    expect(findItem(c, 'item:gone')).toBeNull();
  });

  it("shows the dragged item in the column it is over, keeping the column it started in, at the end of a lane's own tasks for none named", () => {
    const shown = withDrag(c, 'item:a', { to: 'next', before: 'd' });
    expect(ids(shown)).toMatchObject({ later: ['item:b', 'item:c'], next: ['item:a', 'item:d', 'item:p', 'item:lo1', 'item:lo2'] });
    expect(findItem(shown, 'item:a')).toEqual({ item: c.later[0], column: 'next' });
    expect(ids(withDrag(c, 'item:a', { to: 'next', before: null })).next).toEqual(['item:d', 'item:p', 'item:a', 'item:lo1', 'item:lo2']);
    expect(ids(withDrag(c, 'item:d', { to: 'later', before: null })).later).toEqual(['item:a', 'item:b', 'item:c', 'item:d']);
    // In Progress takes it at the end and Done at the top, as a move on its way shows it.
    expect(ids(withDrag(c, 'item:e', { to: 'progress', before: null }))).toMatchObject({
      progress: [open, 'item:rcur00000001', 'item:carried', 'item:e'],
      doneEarlier: [],
    });
    expect(ids(withDrag(c, open, { to: 'done', before: null })).doneToday).toEqual([open, ticked]);
    expect(withDrag(c, 'item:gone', { to: 'next', before: null })).toBe(c);
  });

  describe('dropTarget', () => {
    it('lands nowhere without a droppable, or for an id no column shows', () => {
      expect(dropTarget(null, 'item:a', c)).toBeNull();
      expect(dropTarget('item:gone', 'item:a', c)).toBeNull();
      expect(dropTarget('item:b', 'item:gone', c)).toBeNull();
    });

    it("goes before the task it is over in another lane, at the end of a lane's own tasks, and anywhere in In Progress or Done", () => {
      expect(dropTarget('item:d', 'item:a', c)).toEqual({ to: 'next', before: 'd' });
      expect(dropTarget('item:p', 'item:a', c)).toEqual({ to: 'next', before: 'p' });
      expect(dropTarget(columnDropId('next'), 'item:a', c)).toEqual({ to: 'next', before: null });
      // Over a task left open: the end of Next's own tasks.
      expect(dropTarget('item:lo1', 'item:a', c)).toEqual({ to: 'next', before: null });
      expect(dropTarget('item:lo2', open, c)).toEqual({ to: 'next', before: null });
      expect(dropTarget(columnDropId('progress'), 'item:a', c)).toEqual({ to: 'progress', before: null });
      expect(dropTarget(columnDropId('done'), open, c)).toEqual({ to: 'done', before: null });
      expect(dropTarget(columnDropId('later'), open, c)).toEqual({ to: 'later', before: null });
      // Today's rows take no drop of their own: over one is over its column.
      expect(dropTarget(open, 'item:a', c)).toEqual({ to: 'progress', before: null });
    });

    it('takes the place of the task it is over in its own lane, as the list showed it sorting', () => {
      expect(dropTarget('item:c', 'item:a', c)).toEqual({ to: 'later', before: null });
      expect(dropTarget('item:b', 'item:a', c)).toEqual({ to: 'later', before: 'c' });
      expect(dropTarget('item:a', 'item:c', c)).toEqual({ to: 'later', before: 'a' });
      expect(dropTarget('item:p', 'item:d', c)).toEqual({ to: 'next', before: null });
    });

    it("gives a task left open a place in Next: before the own task it is over, else the end of Next's own tasks", () => {
      expect(dropTarget('item:d', 'item:lo1', c)).toEqual({ to: 'next', before: 'd' });
      expect(dropTarget('item:p', 'item:lo2', c)).toEqual({ to: 'next', before: 'p' });
      // Over another task left open, or past it.
      expect(dropTarget('item:lo1', 'item:lo2', c)).toEqual({ to: 'next', before: null });
      expect(dropTarget('item:lo2', 'item:lo1', c)).toEqual({ to: 'next', before: null });
    });

    it("lands where it started: over itself, over its own column, or for a lane's own task, before the same task", () => {
      expect(dropTarget('item:a', 'item:a', c)).toBeNull();
      expect(dropTarget(columnDropId('later'), 'item:b', c)).toBeNull();
      expect(dropTarget('item:lo1', 'item:lo1', c)).toBeNull();
      expect(dropTarget(columnDropId('next'), 'item:lo2', c)).toBeNull();
      // Next's last own task over a task left open: still the end of its own tasks.
      expect(dropTarget('item:lo1', 'item:p', c)).toBeNull();
      expect(dropTarget(columnDropId('progress'), open, c)).toBeNull();
      expect(dropTarget(columnDropId('done'), 'item:e', c)).toBeNull();
      expect(dropTarget(columnDropId('done'), ticked, c)).toBeNull();
    });

    it('reads the columns as the drag shows them, with the item in the column it is over', () => {
      const shown = withDrag(c, 'item:a', { to: 'next', before: 'd' });
      expect(dropTarget('item:a', 'item:a', shown)).toEqual({ to: 'next', before: 'd' });
      expect(dropTarget('item:d', 'item:a', shown)).toEqual({ to: 'next', before: 'p' });
      expect(dropTarget('item:p', 'item:a', shown)).toEqual({ to: 'next', before: null });
      expect(dropTarget(columnDropId('progress'), 'item:a', withDrag(c, 'item:a', { to: 'progress', before: null }))).toEqual({
        to: 'progress',
        before: null,
      });
      // A row of today shown in Later lands there; back over In Progress, it is where it started.
      const parked = withDrag(c, open, { to: 'later', before: 'a' });
      expect(dropTarget(open, open, parked)).toEqual({ to: 'later', before: 'a' });
      expect(dropTarget(columnDropId('progress'), open, parked)).toBeNull();
      // Shown in Next, then back over the top of its own lane: it goes there, though B started first after A.
      expect(dropTarget('item:a', 'item:b', withDrag(c, 'item:b', { to: 'next', before: null }))).toEqual({ to: 'later', before: 'a' });
    });
  });

  it('says how a drop ended: stayed, moved, turned down, or done and staying done', () => {
    expect(moveAnnouncement(null, item('item:a'), 'later')).toBe(BOARD_DRAG.stays('A', 'Later'));
    expect(moveAnnouncement(null, item(open), 'progress')).toBe(BOARD_DRAG.stays('Open', 'In Progress'));
    expect(moveAnnouncement(planMove(item('item:a'), 'next', 'd', WED), item('item:a'), 'next')).toBe(BOARD_DRAG.moved('A', 'Next'));
    expect(moveAnnouncement(planMove(item(open), 'done', null, WED), item(open), 'done')).toBe(BOARD_DRAG.moved('Open', 'Done'));
    expect(moveAnnouncement(planMove(item(ticked), 'next', null, WED), item(ticked), 'next')).toBe(DONE_STAYS.announce('Ticked', 'Next'));
    const recurring = item('item:rcur00000001');
    expect(moveAnnouncement(planMove(recurring, 'next', null, WED), recurring, 'next')).toBe(BOARD.recurringStays('Monitor the queue'));
  });

  it('says where a dragged item would land: the column, and in Later or Next before which task, or back where it started', () => {
    expect(overAnnouncement(null, item('item:a'), c)).toBe(BOARD_DRAG.overStart('A', 'Later'));
    expect(overAnnouncement({ to: 'progress', before: null }, item('item:a'), c)).toBe(BOARD_DRAG.over('A', 'In Progress'));
    expect(overAnnouncement({ to: 'next', before: 'd' }, item('item:a'), c)).toBe(BOARD_DRAG.overBefore('A', 'Next', 'D'));
    expect(overAnnouncement({ to: 'next', before: null }, item('item:a'), c)).toBe(BOARD_DRAG.overEnd('A', 'Next'));
  });
});
