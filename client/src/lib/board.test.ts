import { describe, expect, it } from 'vitest';
import { CATEGORY_COLORS, LIMITS } from '../../../shared/api.js';
import { makeBoard, makeCard, makeCategory, makeDay, makePriority, makeRecurring, T0 } from '../test/fixtures';
import type { BoardCard, Category, CategoryColor, Priority } from '../types';
import {
  activeCategories,
  addsToLanes,
  boardColumns,
  boardFull,
  categoryForName,
  categoryNameTaken,
  categoryOf,
  columnDropId,
  dropTarget,
  findItem,
  laneStart,
  MoveRefused,
  moveAnnouncement,
  moveTargets,
  offeredLeftovers,
  overAnnouncement,
  planMove,
  nextColor,
  plannedFor,
  withCategory,
  withCategoryPatch,
  withDrag,
  withItem,
  withItemPatch,
  withoutCategory,
  withoutItem,
  type BoardColumns,
  type BoardItem,
  type ColumnId,
  type ColumnsInput,
} from './board';
import { BOARD, BOARD_DRAG, DONE_STAYS } from './copy';

// A Wednesday, so the week has a Monday and a Tuesday before it.
const MON = '2026-09-28';
const TUE = '2026-09-29';
const WED = '2026-09-30';
const THU = '2026-10-01';
const FRI = '2026-10-02';

function columns(input: Partial<ColumnsInput> = {}): BoardColumns {
  return boardColumns({ cards: [], today: WED, todayRows: [], earlierDays: [], ...input });
}

/** Each column as its items' ids. */
function ids(c: BoardColumns): Record<keyof BoardColumns, string[]> {
  const of = (items: BoardItem[]) => items.map((i) => i.id);
  return { later: of(c.later), next: of(c.next), progress: of(c.progress), doneToday: of(c.doneToday), doneEarlier: of(c.doneEarlier) };
}

const row = (position: number, text: string, patch: Partial<Priority> = {}) =>
  makePriority(position, text, { uid: `row${position}`.padEnd(12, '0'), ...patch });
const rowUid = (position: number) => `row${position}`.padEnd(12, '0');
const ROUTINE = { uid: 'rcur00000001', recurring: true };
const EMPTY = { later: [], next: [], progress: [], doneToday: [], doneEarlier: [] };

describe('boardColumns', () => {
  it("shows Later and Next by position, and In progress as today's open rows, each task once", () => {
    const cards = [
      makeCard('later2', 'B', { position: 2 }),
      makeCard('later1', 'A', { position: 1 }),
      makeCard('next1', 'C', { lane: 'next', position: 1 }),
      makeCard('linked', 'Report', { lane: 'next', position: 2, listDate: WED, listed: 2 }),
    ];
    const todayRows = [row(1, 'Report', { uid: 'linked' }), row(2, 'Typed today'), makePriority(3, '', { uid: null, addedAt: null })];
    const c = columns({ cards, todayRows });
    expect(ids(c)).toEqual({ ...EMPTY, later: ['item:later1', 'item:later2'], next: ['item:next1'], progress: ['item:linked', `item:${rowUid(2)}`] });
    expect(c.progress[0]).toMatchObject({
      uid: 'linked',
      title: 'Report',
      column: 'progress',
      card: cards[3],
      row: todayRows[0],
      date: WED,
      planned: null,
      leftOpen: null,
    });
    // A task typed seconds ago, which the board hasn't read yet, shows as its row.
    expect(c.progress[1]).toMatchObject({ uid: rowUid(2), card: null, recurring: false });
    expect(c.later[0]).toMatchObject({ uid: 'later1', title: 'A', row: null, date: null });
  });

  it('shows a recurring row of today by its day, never by a task of the board', () => {
    const c = columns({ todayRows: [row(1, 'Monitor the queue', ROUTINE), row(2, 'Follow-ups', { uid: 'rcur00000002', recurring: true, done: true })] });
    expect(ids(c)).toEqual({ ...EMPTY, progress: [`row:${WED}:rcur00000001`], doneToday: [`row:${WED}:rcur00000002`] });
    expect(c.progress[0]).toMatchObject({ recurring: true, card: null, uid: 'rcur00000001' });
  });

  it("shows a task a later day's list holds in Next as planned: in its place when its lane is Next, else after the tasks left open, by day", () => {
    const cards = [
      makeCard('own', 'Own', { lane: 'next', position: 1 }),
      makeCard('plannedNext', 'Planned in Next', { lane: 'next', position: 2, listDate: THU }),
      makeCard('fri', 'From Later, Friday', { lane: 'later', listDate: FRI }),
      makeCard('thu', 'Typed on Thursday', { lane: null, listDate: THU }),
      makeCard('ticked', 'Ticked ahead', { lane: null, listDate: THU, listDone: true }),
      makeCard('left', 'Left open', { lane: null, listDate: TUE }),
      makeCard('past', 'Listed on Monday', { lane: 'later', position: 2, listDate: MON }),
    ];
    const c = columns({ cards });
    expect(ids(c).next).toEqual(['item:own', 'item:plannedNext', 'item:left', 'item:thu', 'item:ticked', 'item:fri']);
    expect(c.next.map((i) => i.planned)).toEqual([null, THU, null, THU, THU, FRI]);
    expect(ids(c).later).toEqual(['item:past']);
  });

  it("keeps today's row tickable when its task is planned for a later day too: the row shows, never planned", () => {
    const c = columns({ cards: [makeCard('carried', 'Report', { lane: 'next', listDate: THU })], todayRows: [row(1, 'Report', { uid: 'carried' })] });
    expect(ids(c)).toEqual({ ...EMPTY, progress: ['item:carried'] });
    expect(c.progress[0]!.planned).toBeNull();
  });

  it("leads Done with today's ticked rows, then the tasks off today's list whose latest entry, today's, was ticked", () => {
    const cards = [makeCard('elsewhere', 'Ticked on another device', { lane: null, listDate: WED, listDone: true })];
    const todayRows = [row(1, 'Open'), row(2, 'Ticked here', { done: true }), row(3, 'Ticked too', { done: true })];
    const c = columns({ cards, todayRows });
    expect(ids(c).doneToday).toEqual([`item:${rowUid(2)}`, `item:${rowUid(3)}`, 'item:elsewhere']);
    expect(c.doneToday[0]).toMatchObject({ column: 'done', date: WED });
  });

  it("holds the tasks done this week whatever their lane, newest day first, with each day's routine ticks, and leaves out what was done before Monday", () => {
    const cards = [
      makeCard('mon', 'Monday task', { lane: null, listDate: MON, listDone: true }),
      makeCard('tue', 'Tuesday task', { lane: 'next', listDate: TUE, listDone: true }),
      makeCard('lastWeek', 'Last week', { lane: 'later', listDate: '2026-09-27', listDone: true }),
    ];
    const tuesday = makeDay(TUE, {
      priorities: [row(1, 'Monitor the queue', { ...ROUTINE, done: true }), row(2, 'Follow-ups', { uid: 'rcur00000002', recurring: true })],
    });
    const monday = makeDay(MON, { priorities: [row(1, 'Monitor the queue', { ...ROUTINE, done: true }), row(2, 'Monday task', { uid: 'mon', done: true })] });
    const c = columns({ cards, earlierDays: [monday, tuesday] });
    expect(ids(c)).toEqual({ ...EMPTY, doneEarlier: ['item:tue', `row:${TUE}:rcur00000001`, 'item:mon', `row:${MON}:rcur00000001`] });
    expect(c.doneEarlier[1]).toMatchObject({ title: 'Monitor the queue', column: 'done', card: null, date: TUE, recurring: true });
  });

  it('gives a routine ticked today and on two earlier days three Done items with ids of their own', () => {
    const ticked = (date: string) => makeDay(date, { priorities: [row(1, 'Monitor the queue', { ...ROUTINE, done: true })] });
    const c = columns({ todayRows: ticked(WED).priorities, earlierDays: [ticked(MON), ticked(TUE)] });
    const done = [...ids(c).doneToday, ...ids(c).doneEarlier];
    expect(done).toEqual([`row:${WED}:rcur00000001`, `row:${TUE}:rcur00000001`, `row:${MON}:rcur00000001`]);
    expect(new Set(done).size).toBe(3);
  });

  describe('a task left open', () => {
    const own = makeCard('own', 'Own', { lane: 'next' });

    it('shows in Next after its own tasks while its latest entry, open, is from the last 14 days, newest day first, then the one made first', () => {
      const cards = [
        makeCard('old', 'Two weeks back', { lane: null, listDate: '2026-09-16' }),
        makeCard('later', 'Made later', { lane: null, listDate: TUE, createdAt: T0 + 1 }),
        own,
        makeCard('first', 'Made first', { lane: null, listDate: TUE, createdAt: T0 }),
        makeCard('gone', 'Fifteen days back', { lane: null, listDate: '2026-09-15' }),
      ];
      const c = columns({ cards });
      expect(ids(c)).toEqual({ ...EMPTY, next: ['item:own', 'item:first', 'item:later', 'item:old'] });
      expect(c.next.map((i) => i.leftOpen)).toEqual([null, TUE, TUE, '2026-09-16']);
    });

    it('is a task in no lane: one ticked, one with a lane, one on no list and a routine left open show where they are', () => {
      const cards = [
        makeCard('ticked', 'Ticked', { lane: null, listDate: TUE, listDone: true }),
        makeCard('laned', 'In Later', { lane: 'later', listDate: TUE }),
        makeCard('nowhere', 'Never listed', { lane: null }),
        // Its latest entry today, on another device: no longer on the list this copy shows.
        makeCard('offToday', 'Taken off today', { lane: null, listDate: WED }),
      ];
      const tuesday = makeDay(TUE, { priorities: [row(1, 'Monitor the queue', ROUTINE)] });
      const c = columns({ cards, earlierDays: [tuesday] });
      expect(ids(c)).toEqual({ ...EMPTY, later: ['item:laned'], doneEarlier: ['item:ticked'] });
    });
  });

  it('shows a moving item in the column it is going to: the top of Later and Done, the end of Next and In progress', () => {
    const cards = [makeCard('a', 'A'), makeCard('b', 'B', { lane: 'next' }), makeCard('c', 'C', { position: 2 })];
    const todayRows = [row(1, 'One'), row(2, 'Two', { done: true })];
    const moving = new Map<string, ColumnId>([
      ['item:c', 'next'],
      [`item:${rowUid(1)}`, 'later'],
      ['item:a', 'later'],
      ['item:b', 'progress'],
      [`item:${rowUid(2)}`, 'progress'],
    ]);
    const c = columns({ cards, todayRows, moving });
    expect(ids(c)).toEqual({
      later: [`item:${rowUid(1)}`, 'item:a'],
      next: ['item:c'],
      progress: ['item:b', `item:${rowUid(2)}`],
      doneToday: [],
      doneEarlier: [],
    });
    expect(c.later[0]!.column).toBe('later');
    const done = columns({ cards, moving: new Map([['item:a', 'done' as const]]) });
    expect(ids(done).doneToday).toEqual(['item:a']);
    // Nothing moving gives the columns as they are.
    expect(columns({ cards, moving: new Map() })).toEqual(columns({ cards }));
  });
});

describe('the small lookups', () => {
  it("plannedFor: the later day whose list holds the task, never today or before, nor for a row the board hasn't read", () => {
    const items = columns({
      cards: [makeCard('t', 'T', { lane: 'next', listDate: THU }), makeCard('w', 'W', { lane: 'next', listDate: WED }), makeCard('n', 'N', { lane: 'next' })],
      todayRows: [row(1, 'Typed')],
    });
    expect(items.next.map((i) => plannedFor(i, WED))).toEqual([THU, null, null]);
    expect(plannedFor(items.progress[0]!, WED)).toBeNull();
  });

  it('boardFull: the tasks in Later and Next that are not done, at the cap', () => {
    const open = Array.from({ length: 299 }, (_, i) => makeCard(`c${i}`, 'C', { lane: i % 2 ? 'next' : 'later' }));
    expect(boardFull(makeBoard(...open, makeCard('done', 'D', { lane: 'next', listDate: TUE, listDone: true }), makeCard('none', 'N', { lane: null })))).toBe(
      false,
    );
    expect(boardFull(makeBoard(...open, makeCard('one', 'More')))).toBe(true);
  });

  it('addsToLanes: a task in no lane, a done one, or one the copy lacks takes room in the lanes; one in a lane already, none', () => {
    const board = makeBoard(makeCard('a', 'A'), makeCard('b', 'B', { lane: null }), makeCard('c', 'C', { lane: 'next', listDone: true, listDate: TUE }));
    expect(['a', 'b', 'c', 'gone'].map((uid) => addsToLanes(board, uid))).toEqual([false, true, true, true]);
  });

  it("laneStart: the top of Later's own tasks, the end of Next's", () => {
    const c = columns({ cards: [makeCard('first', 'First'), makeCard('second', 'Second', { position: 2 })], todayRows: [row(1, 'Parking')] });
    expect(laneStart(c, 'later')).toBe('first');
    expect(laneStart(c, 'next')).toBeNull();
    expect(laneStart(columns(), 'later')).toBeNull();
    // A row on its way to Later shows at the top, and isn't a place in the lane yet.
    const moving = columns({ cards: [makeCard('first', 'First')], todayRows: [row(1, 'Parking')], moving: new Map([[`item:${rowUid(1)}`, 'later' as const]]) });
    expect(laneStart(moving, 'later')).toBe('first');
  });
});

describe('planMove', () => {
  const ctx = { today: WED };
  const cards: BoardCard[] = [
    makeCard('later', 'Write a KB', { categoryUid: 'cafe00000003', listed: 2, logged: 600 }),
    makeCard('next', 'Follow up', { lane: 'next' }),
    makeCard('planned', 'Plan B', { lane: 'next', position: 2, listDate: THU }),
    makeCard('doneTue', 'Shipped', { lane: null, listDate: TUE, listDone: true, listed: 1, logged: 1500 }),
    makeCard('carried', 'Carried', { lane: 'next', position: 3, listDate: THU }),
    makeCard('left', 'Left open', { lane: null, listDate: TUE, categoryUid: 'cafe00000002' }),
  ];
  const todayRows = [
    row(1, 'Open', { categoryUid: 'cafe00000001' }),
    row(2, 'Ticked', { done: true }),
    row(3, 'Monitor the queue', ROUTINE),
    row(4, 'Carried', { uid: 'carried' }),
  ];
  const tuesday = makeDay(TUE, {
    priorities: [row(1, 'Follow-ups', { uid: 'rcur00000002', recurring: true, done: true, categoryUid: 'cafe00000004', listed: 5, logged: 300 })],
  });
  const c = columns({ cards, todayRows, earlierDays: [tuesday] });
  const item = (id: string) => findItem(c, id)!.item;
  const open = item(`item:${rowUid(1)}`);
  const ticked = item(`item:${rowUid(2)}`);
  const recurring = item(`row:${WED}:rcur00000001`);
  const carried = item('item:carried');
  const left = item('item:left');
  const routineTicked = item(`row:${TUE}:rcur00000002`);

  it('moves a task between Later and Next, or within one, as a patch', () => {
    expect(planMove(item('item:later'), 'next', null, ctx)).toEqual({ kind: 'patch', uid: 'later', patch: { lane: 'next', before: null } });
    expect(planMove(item('item:next'), 'later', 'later', ctx)).toEqual({ kind: 'patch', uid: 'next', patch: { lane: 'later', before: 'later' } });
    expect(planMove(item('item:next'), 'next', null, ctx)).toEqual({ kind: 'patch', uid: 'next', patch: { before: null } });
  });

  it('gives a task left open a place of its own in Next, or in Later', () => {
    expect(planMove(left, 'next', 'next', ctx)).toEqual({ kind: 'patch', uid: 'left', patch: { lane: 'next', before: 'next' } });
    expect(planMove(left, 'later', null, ctx)).toEqual({ kind: 'patch', uid: 'left', patch: { lane: 'later', before: null } });
  });

  it("sorts nothing for today's row shown in a lane while its park is on its way", () => {
    expect(planMove({ ...open, column: 'later' }, 'later', 'later', ctx)).toBeNull();
    expect(planMove({ ...carried, column: 'next' }, 'next', null, ctx)).toBeNull();
  });

  it("puts a task of Later or Next on today's list as itself, in its category, with the board's counts: open with the nudge, ticked without", () => {
    expect(planMove(item('item:later'), 'progress', null, ctx)).toEqual({
      kind: 'place',
      row: {
        uid: 'later',
        addedAt: null,
        text: 'Write a KB',
        done: false,
        categoryUid: 'cafe00000003',
        recurring: false,
        archived: false,
        listed: 2,
        earlier: 0,
        logged: 600,
      },
      nudge: true,
    });
    expect(planMove(item('item:next'), 'done', null, ctx)).toMatchObject({ kind: 'place', row: { uid: 'next', text: 'Follow up', done: true }, nudge: false });
    expect(planMove(left, 'progress', null, ctx)).toMatchObject({ kind: 'place', row: { uid: 'left', categoryUid: 'cafe00000002' }, nudge: true });
  });

  it('pulls a task done on an earlier day into In progress, the same task again', () => {
    expect(planMove(item('item:doneTue'), 'progress', null, ctx)).toMatchObject({
      kind: 'place',
      row: { uid: 'doneTue', text: 'Shipped', done: false, listed: 1, logged: 1500 },
      nudge: true,
    });
  });

  it("puts an earlier day's routine tick back on today as the same recurring priority, with that row's counts", () => {
    expect(planMove(routineTicked, 'progress', null, ctx)).toEqual({
      kind: 'place',
      row: {
        uid: 'rcur00000002',
        addedAt: null,
        text: 'Follow-ups',
        done: false,
        categoryUid: 'cafe00000004',
        recurring: true,
        archived: false,
        listed: 5,
        earlier: 0,
        logged: 300,
      },
      nudge: true,
    });
  });

  it("ticks and unticks today's rows between In progress and Done", () => {
    expect(planMove(open, 'done', null, ctx)).toEqual({ kind: 'tick', uid: rowUid(1), done: true });
    expect(planMove(ticked, 'progress', null, ctx)).toEqual({ kind: 'tick', uid: rowUid(2), done: false });
    expect(planMove(recurring, 'done', null, ctx)).toEqual({ kind: 'tick', uid: 'rcur00000001', done: true });
  });

  it("parks today's open row in Later or Next", () => {
    expect(planMove(open, 'later', 'later', ctx)).toEqual({ kind: 'park', uid: rowUid(1), lane: 'later', before: 'later' });
    expect(planMove(open, 'next', null, ctx)).toEqual({ kind: 'park', uid: rowUid(1), lane: 'next', before: null });
  });

  it("parks today's row whose task a later day's list holds in Next only, where it stays planned", () => {
    expect(planMove(carried, 'next', null, ctx)).toEqual({ kind: 'park', uid: 'carried', lane: 'next', before: null });
    expect(planMove(carried, 'later', null, ctx)).toEqual({ kind: 'refuse', message: BOARD.planned('Carried', 'tomorrow') });
  });

  it("keeps a done item done: today's ticked row and a task done earlier moved to Later or Next give the notice, with where it was dropped and its category", () => {
    expect(planMove(ticked, 'later', 'later', ctx)).toEqual({ kind: 'doneStays', title: 'Ticked', categoryUid: null, lane: 'later', before: 'later' });
    expect(planMove(item('item:doneTue'), 'next', null, ctx)).toEqual({ kind: 'doneStays', title: 'Shipped', categoryUid: null, lane: 'next', before: null });
  });

  it('refuses a recurring row in Later or Next, ticked or not, and any move of a planned task', () => {
    expect(planMove(recurring, 'later', null, ctx)).toEqual({ kind: 'refuse', message: BOARD.recurringStays('Monitor the queue') });
    expect(planMove(routineTicked, 'next', null, ctx)).toEqual({ kind: 'refuse', message: BOARD.recurringStays('Follow-ups') });
    for (const to of ['later', 'next', 'progress', 'done'] as const) {
      expect(planMove(item('item:planned'), to, null, ctx)).toEqual({ kind: 'refuse', message: BOARD.planned('Plan B', 'tomorrow') });
    }
  });

  it('does nothing for a drop where the item already is in In progress or Done', () => {
    expect(planMove(open, 'progress', null, ctx)).toBeNull();
    expect(planMove(ticked, 'done', null, ctx)).toBeNull();
    expect(planMove(item('item:doneTue'), 'done', null, ctx)).toBeNull();
    expect(planMove(routineTicked, 'done', null, ctx)).toBeNull();
  });

  it('offers every other column, Next for a task left open, none for a planned task, and no Later or Next for a recurring row', () => {
    expect(moveTargets(item('item:later'))).toEqual(['next', 'progress', 'done']);
    expect(moveTargets(open)).toEqual(['later', 'next', 'done']);
    expect(moveTargets(left)).toEqual(['later', 'next', 'progress', 'done']);
    // Done items and today's row planned later keep Later and Next, which answer with the notice.
    expect(moveTargets(ticked)).toEqual(['later', 'next', 'progress']);
    expect(moveTargets(item('item:doneTue'))).toEqual(['later', 'next', 'progress']);
    expect(moveTargets(carried)).toEqual(['later', 'next', 'done']);
    expect(moveTargets(recurring)).toEqual(['done']);
    expect(moveTargets(routineTicked)).toEqual(['progress']);
    expect(moveTargets(item('item:planned'))).toEqual([]);
  });
});

describe('dragging', () => {
  const ctx = { today: WED };
  const NAMES: Record<ColumnId, string> = { later: 'Later', next: 'Next', progress: 'In progress', done: 'Done' };
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
    makeCard('f', 'Friday', { lane: null, listDate: FRI }),
  ];
  const todayRows = [row(1, 'Open'), row(2, 'Ticked', { done: true }), row(3, 'Monitor the queue', ROUTINE), row(4, 'Carried', { uid: 'carried' })];
  const c = columns({ cards, todayRows });
  const open = `item:${rowUid(1)}`;
  const ticked = `item:${rowUid(2)}`;
  const item = (id: string) => findItem(c, id)!.item;

  it('finds an item and the column showing it, the week of Done included', () => {
    expect(ids(c).next).toEqual(['item:d', 'item:p', 'item:lo1', 'item:lo2', 'item:f']);
    expect(findItem(c, 'item:b')).toEqual({ item: c.later[1], column: 'later' });
    expect(findItem(c, 'item:e')).toEqual({ item: c.doneEarlier[0], column: 'done' });
    expect(findItem(c, ticked)).toEqual({ item: c.doneToday[0], column: 'done' });
    expect(findItem(c, 'item:gone')).toBeNull();
  });

  it("shows the dragged item in the column it is over, keeping the column it started in, at the end of a lane's own tasks for none named", () => {
    const shown = withDrag(c, 'item:a', { to: 'next', before: 'd' });
    expect(ids(shown)).toMatchObject({ later: ['item:b', 'item:c'], next: ['item:a', 'item:d', 'item:p', 'item:lo1', 'item:lo2', 'item:f'] });
    expect(findItem(shown, 'item:a')).toEqual({ item: c.later[0], column: 'next' });
    expect(ids(withDrag(c, 'item:a', { to: 'next', before: null })).next).toEqual(['item:d', 'item:p', 'item:a', 'item:lo1', 'item:lo2', 'item:f']);
    expect(ids(withDrag(c, 'item:d', { to: 'later', before: null })).later).toEqual(['item:a', 'item:b', 'item:c', 'item:d']);
    // In progress takes it at the end and Done at the top, as a move on its way shows it.
    expect(ids(withDrag(c, 'item:e', { to: 'progress', before: null }))).toMatchObject({
      progress: [open, `row:${WED}:rcur00000001`, 'item:carried', 'item:e'],
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

    it("goes before the task it is over in another lane, at the end of a lane's own tasks, and anywhere in In progress or Done", () => {
      expect(dropTarget('item:d', 'item:a', c)).toEqual({ to: 'next', before: 'd' });
      expect(dropTarget('item:p', 'item:a', c)).toEqual({ to: 'next', before: 'p' });
      expect(dropTarget(columnDropId('next'), 'item:a', c)).toEqual({ to: 'next', before: null });
      // Over a task left open or one planned with no place: the end of Next's own tasks.
      expect(dropTarget('item:lo1', 'item:a', c)).toEqual({ to: 'next', before: null });
      expect(dropTarget('item:f', open, c)).toEqual({ to: 'next', before: null });
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
      // A row of today shown in Later lands there; back over In progress, it is where it started.
      const parked = withDrag(c, open, { to: 'later', before: 'a' });
      expect(dropTarget(open, open, parked)).toEqual({ to: 'later', before: 'a' });
      expect(dropTarget(columnDropId('progress'), open, parked)).toBeNull();
      // Shown in Next, then back over the top of its own lane: it goes there, though B started first after A.
      expect(dropTarget('item:a', 'item:b', withDrag(c, 'item:b', { to: 'next', before: null }))).toEqual({ to: 'later', before: 'a' });
    });
  });

  it('says how a drop ended: stayed, moved, turned down, or done and staying done', () => {
    expect(moveAnnouncement(null, item('item:a'), 'later', NAMES)).toBe(BOARD_DRAG.stays('A', 'Later'));
    expect(moveAnnouncement(null, item(open), 'progress', NAMES)).toBe(BOARD_DRAG.stays('Open', 'In progress'));
    expect(moveAnnouncement(planMove(item('item:a'), 'next', 'd', ctx), item('item:a'), 'next', NAMES)).toBe(BOARD_DRAG.moved('A', 'Next'));
    expect(moveAnnouncement(planMove(item(open), 'done', null, ctx), item(open), 'done', NAMES)).toBe(BOARD_DRAG.moved('Open', 'Done'));
    expect(moveAnnouncement(planMove(item(ticked), 'next', null, ctx), item(ticked), 'next', NAMES)).toBe(DONE_STAYS.announce('Ticked', 'Next'));
    const carried = item('item:carried');
    expect(moveAnnouncement(planMove(carried, 'later', null, ctx), carried, 'later', NAMES)).toBe(BOARD.planned('Carried', 'tomorrow'));
    const recurring = item(`row:${WED}:rcur00000001`);
    expect(moveAnnouncement(planMove(recurring, 'next', null, ctx), recurring, 'next', NAMES)).toBe(BOARD.recurringStays('Monitor the queue'));
  });

  it('says where a dragged item would land: the column, and in Later or Next before which task, or back where it started', () => {
    expect(overAnnouncement(null, item('item:a'), c, NAMES)).toBe(BOARD_DRAG.overStart('A', 'Later'));
    expect(overAnnouncement({ to: 'progress', before: null }, item('item:a'), c, NAMES)).toBe(BOARD_DRAG.over('A', 'In progress'));
    expect(overAnnouncement({ to: 'next', before: 'd' }, item('item:a'), c, NAMES)).toBe(BOARD_DRAG.overBefore('A', 'Next', 'D'));
    expect(overAnnouncement({ to: 'next', before: null }, item('item:a'), c, NAMES)).toBe(BOARD_DRAG.overEnd('A', 'Next'));
  });
});

describe('MoveRefused', () => {
  it('is an Error carrying the line to show', () => {
    const e = new MoveRefused(BOARD.full);
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe(BOARD.full);
  });
});

describe('offeredLeftovers', () => {
  const rows = [
    row(1, 'In Next', { uid: 'next' }),
    row(2, 'In no lane', { uid: 'none' }),
    row(3, 'Parked', { uid: 'later' }),
    row(4, 'Finished since', { uid: 'done' }),
    row(5, 'Not read by the board yet', { uid: 'unread' }),
    row(6, 'Deleted before the update', { uid: 'archived', archived: true }),
  ];
  const cards = [
    makeCard('next', 'In Next', { lane: 'next', listDate: TUE }),
    makeCard('none', 'In no lane', { lane: null, listDate: TUE }),
    makeCard('later', 'Parked', { lane: 'later', listDate: TUE }),
    makeCard('done', 'Finished since', { lane: 'next', listDate: WED, listDone: true }),
  ];

  it("brings back each row's own task, as it is called now, unless the board has it in Later or done; one the board hasn't read is offered", () => {
    expect(offeredLeftovers(rows, cards)).toEqual([rows[0], rows[1], rows[4]]);
  });

  it('never offers an archived task, which is missing from the board', () => {
    expect(offeredLeftovers([rows[5]!], [])).toEqual([]);
  });

  it('offers nothing while the board has not loaded', () => {
    expect(offeredLeftovers(rows, undefined)).toBeNull();
  });
});

describe('the board as a write shows it', () => {
  const queue = makeRecurring('rec000000001', 'Monitor the queue');
  const follow = makeRecurring('rec000000002', 'Follow-ups', { weekdays: [1, 3, 5] });
  const board = {
    ...makeBoard(
      makeCard('l1', 'L1'),
      makeCard('l2', 'L2', { position: 2 }),
      makeCard('n1', 'N1', { lane: 'next' }),
      makeCard('d1', 'D1', { lane: null, position: 0, listDate: '2026-09-29', listDone: true }),
    ),
    recurring: [queue, follow],
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

    it('adds a recurring priority after the others, its weekdays ascending, as the server answers them', () => {
      const added = withItem(board, { uid: 'rec000000003', title: 'Timesheet', categoryUid: null, weekdays: [5, 1] }, T0);
      expect(added.recurring).toEqual([queue, follow, makeRecurring('rec000000003', 'Timesheet', { weekdays: [1, 5] })]);
      expect(added.cards).toBe(board.cards);
    });

    it('leaves the board as it is when the uid is held already, as the server does for a retry', () => {
      expect(withItem(board, { uid: 'd1', title: 'Other', categoryUid: null, lane: 'later', before: null }, T0)).toBe(board);
      expect(withItem(board, { uid: queue.uid, title: 'Other', categoryUid: null, weekdays: [7] }, T0)).toBe(board);
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

    it('patches a category onto a task, or off it, and keeps it when the patch leaves it out', () => {
      const tagged = withItemPatch(board, 'l1', { categoryUid: 'cafe00000001' });
      expect(task(tagged, 'l1')).toMatchObject({ categoryUid: 'cafe00000001', lane: 'later', position: 1 });
      expect(task(withItemPatch(tagged, 'l1', { title: 'Kept' }), 'l1')?.categoryUid).toBe('cafe00000001');
      expect(task(withItemPatch(tagged, 'l1', { categoryUid: null }), 'l1')?.categoryUid).toBeNull();
    });

    it('changes the fields sent of a recurring priority, keeps the ones left out, and puts the weekdays in order', () => {
      expect(withItemPatch(board, follow.uid, { title: 'Chase replies' }).recurring).toEqual([queue, { ...follow, title: 'Chase replies' }]);
      expect(withItemPatch(board, follow.uid, { categoryUid: 'cat000000001' }).recurring[1]).toEqual({ ...follow, categoryUid: 'cat000000001' });
      expect(withItemPatch(board, follow.uid, { weekdays: [7, 2, 4] }).recurring[1]).toEqual({ ...follow, weekdays: [2, 4, 7] });
      const filed = { ...board, recurring: [{ ...queue, categoryUid: 'cat000000001' }] };
      expect(withItemPatch(filed, queue.uid, { categoryUid: null }).recurring[0]).toEqual(queue);
    });
  });

  it('takes a deleted task or a removed recurring priority off', () => {
    expect(withoutItem(board, 'l1').cards.map((c) => c.uid)).toEqual(['l2', 'n1', 'd1']);
    expect(withoutItem(board, queue.uid).recurring).toEqual([follow]);
    expect(withoutItem(board, 'gone00000001')).toEqual(board);
  });
});

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
