import { describe, expect, it } from 'vitest';
import { BOARD_LIMITS } from '../../../shared/api.js';
import { FOLLOW_UPS, makeBoard, makeCard, makeDay, makePriority, makeRecurring, QUEUE, rowUid, T0 } from '../test/fixtures';
import { addsToLanes, boardFull, findItem, laneStart, offeredLeftovers, onToday, topOfNext, type DropTarget } from './board';
import { columns, FRI, ids, MON, ROUTINE, THU, TUE, WED } from './board.testkit';

const EMPTY = { later: [], repeats: [], next: [], progress: [], doneToday: [], doneEarlier: [] };

describe('boardColumns', () => {
  it("shows Later and Next by position, and In Progress as today's open rows, each task once", () => {
    const cards = [
      makeCard('later2', 'B', { position: 2 }),
      makeCard('later1', 'A', { position: 1 }),
      makeCard('next1', 'C', { lane: 'next', position: 1 }),
      makeCard('linked', 'Report', { lane: 'next', position: 2, listDate: WED, listed: 2 }),
    ];
    const todayRows = [makePriority(1, 'Report', { uid: 'linked' }), makePriority(2, 'Typed today'), makePriority(3, '', { uid: null, addedAt: null })];
    const c = columns({ cards, todayRows });
    expect(ids(c)).toEqual({ ...EMPTY, later: ['item:later1', 'item:later2'], next: ['item:next1'], progress: ['item:linked', `item:${rowUid(2)}`] });
    expect(c.progress[0]).toMatchObject({
      uid: 'linked',
      title: 'Report',
      column: 'progress',
      card: cards[3],
      row: todayRows[0],
      date: WED,
      leftOpen: null,
    });
    // A task typed seconds ago, which the board hasn't read yet, shows as its row.
    expect(c.progress[1]).toMatchObject({ uid: rowUid(2), card: null, recurring: false });
    expect(c.later[0]).toMatchObject({ uid: 'later1', title: 'A', row: null, date: null });
  });

  it("shows today's recurring row as its task, and the recurring priorities off today's list in Later's Repeats, in the order given", () => {
    const todayRows = [makePriority(1, 'Monitor the queue', ROUTINE), makePriority(2, 'Follow-ups', { uid: FOLLOW_UPS.uid, recurring: true, done: true })];
    const recurring = [
      makeRecurring('rcur00000003', 'Water the plants', { categoryUid: 'cafe00000001', note: 'The fern too', weekdays: [6] }),
      QUEUE,
      FOLLOW_UPS,
      makeRecurring('rcur00000004', 'Timesheet'),
    ];
    const c = columns({ todayRows, recurring });
    expect(ids(c)).toEqual({
      ...EMPTY,
      repeats: ['item:rcur00000003', 'item:rcur00000004'],
      progress: ['item:rcur00000001'],
      doneToday: ['item:rcur00000002'],
    });
    expect(c.progress[0]).toMatchObject({ recurring: true, card: null, uid: 'rcur00000001' });
    expect(c.repeats[0]).toEqual({
      id: 'item:rcur00000003',
      uid: 'rcur00000003',
      title: 'Water the plants',
      note: 'The fern too',
      column: 'later',
      card: null,
      row: null,
      date: null,
      categoryUid: 'cafe00000001',
      recurring: true,
      leftOpen: null,
    });
    expect(findItem(c, 'item:rcur00000004')).toEqual({ item: c.repeats[1], column: 'later' });
  });

  it("shows today's row of a task the board has as a recurring priority as one, before the day is read again", () => {
    const c = columns({ todayRows: [makePriority(1, 'Report')], recurring: [makeRecurring(rowUid(1), 'Report', { weekdays: [3] })] });
    expect(ids(c)).toEqual({ ...EMPTY, progress: [`item:${rowUid(1)}`] });
    expect(c.progress[0]).toMatchObject({ recurring: true, row: { recurring: false } });
  });

  it("shows a task a later day's list holds as any other: by its lane, in no column until that day with none, and in Done with today's once ticked there, whatever its lane or week", () => {
    const cards = [
      makeCard('own', 'Own', { lane: 'next', position: 1 }),
      makeCard('plannedNext', 'Planned in Next', { lane: 'next', position: 2, listDate: THU }),
      makeCard('fri', 'From Later, Friday', { lane: 'later', listDate: FRI }),
      makeCard('thu', 'Typed on Thursday', { lane: null, listDate: THU }),
      makeCard('ticked', 'Ticked ahead', { lane: null, listDate: THU, listDone: true }),
      makeCard('tickedLater', 'Ticked next week', { lane: 'later', listDate: '2026-10-06', listDone: true }),
      makeCard('left', 'Left open', { lane: null, listDate: TUE }),
      makeCard('past', 'Listed on Monday', { lane: 'later', position: 2, listDate: MON }),
    ];
    expect(ids(columns({ cards }))).toEqual({
      ...EMPTY,
      later: ['item:fri', 'item:past'],
      next: ['item:own', 'item:plannedNext', 'item:left'],
      // No earlier day's: with today's, so the fold doesn't misname it.
      doneToday: ['item:ticked', 'item:tickedLater'],
    });
    expect(ids(columns({ cards, today: THU, todayRows: [makePriority(1, 'Typed on Thursday', { uid: 'thu' })] })).progress).toEqual(['item:thu']);
  });

  it("keeps today's row tickable when a later day's list holds its task too", () => {
    const c = columns({ cards: [makeCard('carried', 'Report', { lane: 'next', listDate: THU })], todayRows: [makePriority(1, 'Report', { uid: 'carried' })] });
    expect(ids(c)).toEqual({ ...EMPTY, progress: ['item:carried'] });
  });

  it("leads Done with today's ticked rows, then the tasks off today's list whose latest entry, today's, was ticked", () => {
    const cards = [makeCard('elsewhere', 'Ticked on another device', { lane: null, listDate: WED, listDone: true })];
    const todayRows = [makePriority(1, 'Open'), makePriority(2, 'Ticked here', { done: true }), makePriority(3, 'Ticked too', { done: true })];
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
      priorities: [makePriority(1, 'Monitor the queue', { ...ROUTINE, done: true }), makePriority(2, 'Follow-ups', { uid: FOLLOW_UPS.uid, recurring: true })],
    });
    const monday = makeDay(MON, {
      priorities: [makePriority(1, 'Monitor the queue', { ...ROUTINE, done: true }), makePriority(2, 'Monday task', { uid: 'mon', done: true })],
    });
    const c = columns({ cards, earlierDays: [monday, tuesday] });
    expect(ids(c)).toEqual({ ...EMPTY, doneEarlier: ['item:tue', `row:${TUE}:rcur00000001`, 'item:mon', `row:${MON}:rcur00000001`] });
    expect(c.doneEarlier[1]).toMatchObject({ title: 'Monitor the queue', column: 'done', card: null, date: TUE, recurring: true });
    // Its recurring priority's title and category, while it repeats, so a rename shows at once.
    const renamed = columns({
      cards,
      earlierDays: [monday, tuesday],
      recurring: [makeRecurring(ROUTINE.uid, 'Watch the queue', { categoryUid: 'cafe00000004' })],
    });
    expect(renamed.doneEarlier[1]!.row).toBe(tuesday.priorities[0]);
    expect(renamed.doneEarlier[1]).toMatchObject({ title: 'Watch the queue', categoryUid: 'cafe00000004' });
    // Gone from the board, it stopped repeating, though the day was read before that.
    expect(c.doneEarlier[1]!.row).toEqual({ ...tuesday.priorities[0], archived: true });
  });

  it('gives a routine ticked today and on two earlier days three Done items with ids of their own', () => {
    const ticked = (date: string) => makeDay(date, { priorities: [makePriority(1, 'Monitor the queue', { ...ROUTINE, done: true })] });
    const c = columns({ todayRows: ticked(WED).priorities, earlierDays: [ticked(MON), ticked(TUE)] });
    const done = [...ids(c).doneToday, ...ids(c).doneEarlier];
    expect(done).toEqual(['item:rcur00000001', `row:${TUE}:rcur00000001`, `row:${MON}:rcur00000001`]);
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
      const tuesday = makeDay(TUE, { priorities: [makePriority(1, 'Monitor the queue', ROUTINE)] });
      const c = columns({ cards, earlierDays: [tuesday] });
      expect(ids(c)).toEqual({ ...EMPTY, later: ['item:laned'], doneEarlier: ['item:ticked'] });
    });
  });

  it('shows a moving item where it lands: in a lane before the task named, else after its own tasks, the end of In Progress, the top of Done', () => {
    const cards = [
      makeCard('a', 'A'),
      makeCard('b', 'B', { lane: 'next' }),
      makeCard('c', 'C', { position: 2 }),
      makeCard('lo', 'Left open', { lane: null, listDate: TUE }),
    ];
    const todayRows = [makePriority(1, 'One'), makePriority(2, 'Two', { done: true }), makePriority(3, 'Three')];
    const moving = new Map<string, DropTarget>([
      ['item:c', { to: 'next', before: null }],
      [`item:${rowUid(1)}`, { to: 'later', before: 'c' }],
      ['item:a', { to: 'later', before: null }],
      ['item:b', { to: 'progress', before: null }],
      [`item:${rowUid(2)}`, { to: 'progress', before: null }],
      [`item:${rowUid(3)}`, { to: 'done', before: null }],
    ]);
    const c = columns({ cards, todayRows, moving });
    expect(ids(c)).toEqual({
      later: ['item:a', `item:${rowUid(1)}`],
      repeats: [],
      next: ['item:c', 'item:lo'],
      progress: ['item:b', `item:${rowUid(2)}`],
      doneToday: [`item:${rowUid(3)}`],
      doneEarlier: [],
    });
    expect(c.later[1]!.column).toBe('later');
    // Nothing moving gives the columns as they are.
    expect(columns({ cards, moving: new Map() })).toEqual(columns({ cards }));
  });

  it("keeps an earlier day's routine tick in Done while it is pulled onto today's list, which shows the row it lands as once", () => {
    const tuesday = makeDay(TUE, { priorities: [makePriority(1, 'Monitor the queue', { ...ROUTINE, done: true })] });
    const pulled = makePriority(1, 'Monitor the queue', ROUTINE);
    const c = columns({
      todayRows: [pulled],
      earlierDays: [tuesday],
      recurring: [QUEUE],
      moving: new Map([[`item:${ROUTINE.uid}`, { to: 'progress', before: null }]]),
    });
    expect(ids(c)).toEqual({ ...EMPTY, progress: [`item:${ROUTINE.uid}`], doneEarlier: [`row:${TUE}:${ROUTINE.uid}`] });
  });

  it("shows a card of Later's Repeats in In Progress while its pull is on its way", () => {
    const c = columns({
      recurring: [QUEUE],
      moving: new Map([[`item:${ROUTINE.uid}`, { to: 'progress', before: null }]]),
    });
    expect(ids(c)).toEqual({ ...EMPTY, progress: [`item:${ROUTINE.uid}`] });
    expect(c.progress[0]).toMatchObject({ column: 'progress', row: null, recurring: true });
  });
});

describe('the small lookups', () => {
  it("onToday: a row of today's list, never a task off it or an earlier day's row", () => {
    const c = columns({
      cards: [makeCard('n', 'N', { lane: 'next' })],
      todayRows: [makePriority(1, 'Typed')],
      earlierDays: [makeDay(TUE, { priorities: [makePriority(1, 'Routine', { ...ROUTINE, done: true })] })],
    });
    expect([c.progress[0]!, c.next[0]!, c.doneEarlier[0]!].map((i) => onToday(i, WED))).toEqual([true, false, false]);
  });

  it('boardFull: the tasks in Later and Next that are not done, at the cap', () => {
    const open = Array.from({ length: BOARD_LIMITS.openCards - 1 }, (_, i) => makeCard(`c${i}`, 'C', { lane: i % 2 ? 'next' : 'later' }));
    expect(boardFull(makeBoard(...open, makeCard('done', 'D', { lane: 'next', listDate: TUE, listDone: true }), makeCard('none', 'N', { lane: null })))).toBe(
      false,
    );
    expect(boardFull(makeBoard(...open, makeCard('one', 'More')))).toBe(true);
  });

  it('addsToLanes: a task in no lane, or one the copy lacks, takes room in the lanes; one in a lane already, done or not, none', () => {
    const board = makeBoard(makeCard('a', 'A'), makeCard('b', 'B', { lane: null }), makeCard('c', 'C', { lane: 'next', listDone: true, listDate: TUE }));
    expect(['a', 'b', 'c', 'gone'].map((uid) => addsToLanes(board, uid))).toEqual([false, true, false, true]);
  });

  it("laneStart: the top of Later's own tasks, the end of Next's", () => {
    const c = columns({ cards: [makeCard('first', 'First'), makeCard('second', 'Second', { position: 2 })], todayRows: [makePriority(1, 'Parking')] });
    expect(laneStart(c, 'later')).toBe('first');
    expect(laneStart(c, 'next')).toBeNull();
    expect(laneStart(columns(), 'later')).toBeNull();
    // A row on its way to Later shows at the top, and isn't a place in the lane yet.
    const moving = columns({
      cards: [makeCard('first', 'First')],
      todayRows: [makePriority(1, 'Parking')],
      moving: new Map([[`item:${rowUid(1)}`, { to: 'later' as const, before: 'first' }]]),
    });
    expect(laneStart(moving, 'later')).toBe('first');
  });
});

describe('offeredLeftovers', () => {
  const rows = [
    makePriority(1, 'In Next', { uid: 'next' }),
    makePriority(2, 'In no lane', { uid: 'none' }),
    makePriority(3, 'Parked', { uid: 'later' }),
    makePriority(4, 'Finished since', { uid: 'done' }),
    makePriority(5, 'Not read by the board yet', { uid: 'unread' }),
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

  it('offers nothing while the board has not loaded', () => {
    expect(offeredLeftovers(rows, undefined)).toBeNull();
  });
});

describe('topOfNext', () => {
  const cards = [
    makeCard('third', 'Third', { lane: 'next', position: 4, categoryUid: 'cafe00000001', note: 'Ask Sam', listed: 2, logged: 600 }),
    makeCard('parked', 'Parked', { lane: 'later', position: 1 }),
    makeCard('leftOpen', 'Left open', { lane: null, listDate: TUE }),
    makeCard('done', 'Done', { lane: 'next', position: 1, listDone: true, listDate: TUE }),
    makeCard('first', 'First', { lane: 'next', position: 2 }),
    makeCard('ticked', 'Ticked on the last plan since the read', { lane: 'next', position: 3 }),
    makeCard('leftover', 'Yesterday', { lane: 'next', position: 5 }),
    makeCard('fourth', 'Fourth', { lane: 'next', position: 6 }),
  ];
  const planned = new Set(['ticked', 'leftover']);

  it("offers Next's own tasks that aren't done in the board's order, less the last plan's, up to the count", () => {
    const before = [...cards];
    expect(topOfNext(cards, planned, 2)).toEqual([
      { uid: 'first', text: 'First', categoryUid: null, note: '', listed: 0, earlier: 0, logged: 0 },
      { uid: 'third', text: 'Third', categoryUid: 'cafe00000001', note: 'Ask Sam', listed: 2, earlier: 0, logged: 600 },
    ]);
    expect(topOfNext(cards, planned, 3).map((s) => s.uid)).toEqual(['first', 'third', 'fourth']);
    expect(cards).toEqual(before);
  });
});
