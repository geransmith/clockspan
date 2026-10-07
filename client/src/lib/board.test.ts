import { describe, expect, it } from 'vitest';
import { HOUR_MS, parseDateKey } from '../../../shared/dates.js';
import { makeBoard, makeCard, makeDay, makePriority, T0 } from '../test/fixtures';
import type { BoardCard, Priority } from '../types';
import {
  boardColumns,
  boardFull,
  cardUidOf,
  laneStart,
  MoveRefused,
  moveTargets,
  needsCard,
  offeredLeftovers,
  planMove,
  plannedFor,
  withCard,
  withoutCard,
  withPatch,
  type BoardColumns,
  type BoardItem,
  type ColumnsInput,
} from './board';
import { BOARD } from './copy';

// A Wednesday, so the week has a Monday and a Tuesday before it.
const MON = '2026-09-28';
const TUE = '2026-09-29';
const WED = '2026-09-30';
const THU = '2026-10-01';
const at = (key: string, hours = 0) => parseDateKey(key).getTime() + hours * HOUR_MS;

function columns(input: Partial<ColumnsInput> = {}): BoardColumns {
  return boardColumns({ cards: [], today: WED, todayRows: [], earlierDays: [], todayStart: at(WED), weekStart: at(MON), ...input });
}

/** Each column as its items' ids. */
function ids(c: BoardColumns): Record<keyof BoardColumns, string[]> {
  const of = (items: BoardItem[]) => items.map((i) => i.id);
  return { later: of(c.later), next: of(c.next), progress: of(c.progress), doneToday: of(c.doneToday), doneEarlier: of(c.doneEarlier) };
}

const row = (position: number, text: string, patch: Partial<Priority> = {}) =>
  makePriority(position, text, { uid: `row${position}`.padEnd(12, '0'), ...patch });
const rowId = (date: string, position: number) => `row:${date}:${`row${position}`.padEnd(12, '0')}`;

describe('needsCard', () => {
  it('is a written row with no card that no recurring priority added', () => {
    expect(needsCard(row(1, 'Report'))).toBe(true);
    expect(needsCard(row(1, ''))).toBe(false);
    expect(needsCard(row(1, 'Report', { cardUid: 'card00000001' }))).toBe(false);
    expect(needsCard(row(1, 'Monitor the queue', { recurringUid: 'rec000000001' }))).toBe(false);
  });
});

describe('boardColumns', () => {
  it('shows Later and Next by position, and In progress as the open rows of today, matched to their cards', () => {
    const cards = [
      makeCard('later2', 'B', { position: 2 }),
      makeCard('later1', 'A', { position: 1 }),
      makeCard('next1', 'C', { lane: 'next', position: 1 }),
      makeCard('linked', 'Report', { lane: 'next', position: 2 }),
    ];
    const todayRows = [row(1, 'Report', { cardUid: 'linked' }), row(2, 'No card yet'), row(3, '')];
    const c = columns({ cards, todayRows });
    expect(ids(c)).toEqual({
      later: ['card:later1', 'card:later2'],
      next: ['card:next1'],
      progress: [rowId(WED, 1), rowId(WED, 2)],
      doneToday: [],
      doneEarlier: [],
    });
    expect(c.progress[0]).toMatchObject({ title: 'Report', column: 'progress', card: cards[3], date: WED, planned: null, recurring: false });
    // A row a save just gave a card this copy doesn't have shows with none.
    expect(c.progress[1]!.card).toBeNull();
    expect(c.later[0]).toMatchObject({ title: 'A', row: null, date: null });
  });

  it('shows an emptied row of today nowhere, and its card nowhere either', () => {
    const c = columns({ cards: [makeCard('emptied', 'Was here', { lane: 'next' })], todayRows: [row(1, '', { cardUid: 'emptied' })] });
    expect(ids(c)).toEqual({ later: [], next: [], progress: [], doneToday: [], doneEarlier: [] });
  });

  it('shows a held card nowhere', () => {
    const c = columns({
      cards: [makeCard('held', 'Held', { lane: 'next', held: true }), makeCard('held2', 'Done held', { lane: 'done', doneAt: at(WED, 9), held: true })],
    });
    expect(ids(c)).toEqual({ later: [], next: [], progress: [], doneToday: [], doneEarlier: [] });
  });

  it("shows a card a later day's list holds in Next as planned, whatever its lane, after Next's own cards by that day", () => {
    const cards = [
      makeCard('own', 'Own', { lane: 'next', position: 1 }),
      makeCard('plannedNext', 'Planned in Next', { lane: 'next', position: 2, listDate: THU }),
      makeCard('fri', 'From Later, Friday', { lane: 'later', listDate: '2026-10-02' }),
      makeCard('thu', 'From Done, Thursday', { lane: 'done', doneAt: at(WED, 8), listDate: THU }),
      makeCard('past', 'Listed on Monday', { lane: 'later', position: 2, listDate: MON }),
    ];
    const c = columns({ cards });
    expect(ids(c).next).toEqual(['card:own', 'card:plannedNext', 'card:thu', 'card:fri']);
    expect(c.next.map((i) => i.planned)).toEqual([null, THU, THU, '2026-10-02']);
    expect(ids(c).later).toEqual(['card:past']);
    expect(ids(c).doneToday).toEqual([]);
  });

  it("keeps today's row tickable when its card is planned for a later day too: the row shows, never planned", () => {
    const c = columns({ cards: [makeCard('carried', 'Report', { lane: 'next', listDate: THU })], todayRows: [row(1, 'Report', { cardUid: 'carried' })] });
    expect(ids(c)).toMatchObject({ next: [], progress: [rowId(WED, 1)] });
    expect(c.progress[0]!.planned).toBeNull();
  });

  it("leads Done with today's ticked rows, then the cards done today, newest first", () => {
    const cards = [
      makeCard('morning', 'Morning', { lane: 'done', doneAt: at(WED, 9) }),
      makeCard('noon', 'Noon', { lane: 'done', doneAt: at(WED, 12) }),
      makeCard('tickedToday', 'Ticked here', { lane: 'done', doneAt: at(WED, 10) }),
    ];
    const todayRows = [row(1, 'Open'), row(2, 'Ticked here', { done: true, cardUid: 'tickedToday' }), row(3, 'Ticked, no card', { done: true })];
    const c = columns({ cards, todayRows });
    expect(ids(c).doneToday).toEqual([rowId(WED, 2), rowId(WED, 3), 'card:noon', 'card:morning']);
    expect(c.doneToday[0]).toMatchObject({ column: 'done', card: cards[2] });
  });

  it('folds the rest of the week into Done earlier, newest day first, and leaves out what was done before Monday', () => {
    const cards = [
      makeCard('mon', 'Monday card', { lane: 'done', doneAt: at(MON, 10) }),
      makeCard('tue', 'Tuesday card', { lane: 'done', doneAt: at(TUE, 15) }),
      makeCard('lastWeek', 'Last week', { lane: 'done', doneAt: at(MON) - HOUR_MS }),
      makeCard('noTime', 'No done time', { lane: 'done', doneAt: null }),
    ];
    const tuesday = makeDay(TUE, { priorities: [row(1, 'Tuesday row', { done: true }), row(2, 'Open on Tuesday')] });
    const monday = makeDay(MON, { priorities: [row(1, 'Monday row', { done: true })] });
    const c = columns({ cards, earlierDays: [monday, tuesday] });
    expect(ids(c).doneEarlier).toEqual(['card:tue', rowId(TUE, 1), 'card:mon', rowId(MON, 1)]);
    expect(c.doneEarlier[1]).toMatchObject({ title: 'Tuesday row', column: 'done', card: null, date: TUE });
  });

  it('shows an earlier ticked row only when no card stands for it: one per card it names, none for a card linked today', () => {
    const cards = [makeCard('kept', 'Kept card', { lane: 'next' })];
    const tuesday = makeDay(TUE, {
      priorities: [
        row(1, 'Card in the copy', { done: true, cardUid: 'kept' }),
        row(2, 'Deleted card', { done: true, cardUid: 'gone00000001' }),
        row(3, 'Back on today', { done: true, cardUid: 'today0000001' }),
      ],
    });
    const monday = makeDay(MON, { priorities: [row(1, 'Deleted card', { done: true, cardUid: 'gone00000001' })] });
    const c = columns({ cards, earlierDays: [tuesday, monday], todayRows: [row(1, 'Back on today', { cardUid: 'today0000001' })] });
    expect(ids(c).doneEarlier).toEqual([rowId(TUE, 2)]);
    expect(ids(c).next).toEqual(['card:kept']);
  });

  it('shows a moving item in the column it is going to: the top of Later and Done, the end of Next and In progress', () => {
    const cards = [makeCard('a', 'A'), makeCard('b', 'B', { lane: 'next' }), makeCard('c', 'C', { position: 2 })];
    const todayRows = [row(1, 'One'), row(2, 'Two', { done: true })];
    const moving = new Map([
      ['card:c', 'next' as const],
      [rowId(WED, 1), 'later' as const],
      ['card:a', 'later' as const],
      ['card:b', 'progress' as const],
      [rowId(WED, 2), 'progress' as const],
    ]);
    const c = columns({ cards, todayRows, moving });
    expect(ids(c)).toEqual({ later: [rowId(WED, 1), 'card:a'], next: ['card:c'], progress: ['card:b', rowId(WED, 2)], doneToday: [], doneEarlier: [] });
    expect(c.later[0]!.column).toBe('later');
    const done = columns({ cards, moving: new Map([['card:a', 'done' as const]]) });
    expect(ids(done).doneToday).toEqual(['card:a']);
    // Nothing moving gives the columns as they are.
    expect(columns({ cards, moving: new Map() })).toEqual(columns({ cards }));
  });
});

describe('the small lookups', () => {
  const [card, cardless] = columns({ cards: [makeCard('a', 'A')], todayRows: [row(1, 'Linked late', { cardUid: 'late00000001' }), row(2, 'None')] }).progress;

  it("cardUidOf: the item's card, else the card its row names, else none", () => {
    const later = columns({ cards: [makeCard('a', 'A')] }).later[0];
    expect(cardUidOf(later)).toBe('a');
    expect(cardUidOf(card)).toBe('late00000001');
    expect(cardUidOf(cardless)).toBeNull();
    expect(cardUidOf(undefined)).toBeNull();
  });

  it('plannedFor: the later day whose list holds the card, never today or before', () => {
    const items = columns({
      cards: [makeCard('t', 'T', { lane: 'next', listDate: THU }), makeCard('w', 'W', { lane: 'next', listDate: WED }), makeCard('n', 'N', { lane: 'next' })],
    }).next;
    expect(items.map((i) => plannedFor(i, WED))).toEqual([THU, null, null]);
    expect(plannedFor(cardless!, WED)).toBeNull();
  });

  it('boardFull: Later and Next at the cap, whatever Done holds', () => {
    const open = Array.from({ length: 299 }, (_, i) => makeCard(`c${i}`, 'C', { lane: i % 2 ? 'next' : 'later' }));
    expect(boardFull(makeBoard(...open, makeCard('done', 'D', { lane: 'done', doneAt: T0 })))).toBe(false);
    expect(boardFull(makeBoard(...open, makeCard('one', 'More')))).toBe(true);
  });

  it('laneStart: the top of Later, the end of Next', () => {
    const c = columns({ cards: [makeCard('first', 'First'), makeCard('second', 'Second', { position: 2 })] });
    expect(laneStart(c, 'later')).toBe('first');
    expect(laneStart(c, 'next')).toBeNull();
    expect(laneStart(columns(), 'later')).toBeNull();
  });
});

describe('planMove', () => {
  const ctx = { today: WED };
  const cards: BoardCard[] = [
    makeCard('later', 'Write a KB', { categoryUid: 'cafe00000003' }),
    makeCard('next', 'Follow up', { lane: 'next' }),
    makeCard('planned', 'Plan B', { lane: 'next', position: 2, listDate: THU }),
    makeCard('doneTue', 'Shipped', { lane: 'done', doneAt: at(TUE, 9) }),
    makeCard('carried', 'Carried', { lane: 'next', position: 3, listDate: THU }),
  ];
  const todayRows = [
    row(1, 'Open', { cardUid: 'open00000001', categoryUid: 'cafe00000001' }),
    row(2, 'Ticked', { done: true, cardUid: 'tick00000001' }),
    row(3, 'Monitor the queue', { recurringUid: 'rec000000001' }),
    row(4, 'Carried', { cardUid: 'carried' }),
    row(5, 'Fresh'),
  ];
  const tuesday = makeDay(TUE, { priorities: [row(1, 'Tuesday row', { done: true, categoryUid: 'cafe00000002' })] });
  const c = columns({ cards, todayRows, earlierDays: [tuesday] });
  const item = (id: string) => [...c.later, ...c.next, ...c.progress, ...c.doneToday, ...c.doneEarlier].find((i) => i.id === id)!;
  const open = item(rowId(WED, 1));
  const ticked = item(rowId(WED, 2));
  const recurring = item(rowId(WED, 3));
  const carried = item(rowId(WED, 4));
  const fresh = item(rowId(WED, 5));
  const earlier = item(rowId(TUE, 1));
  const uid = expect.stringMatching(/^[0-9a-f]{12}$/);

  it('moves a card between Later and Next, or within one, as a patch', () => {
    expect(planMove(item('card:later'), 'next', null, ctx)).toEqual({ kind: 'patch', uid: 'later', patch: { lane: 'next', before: null } });
    expect(planMove(item('card:next'), 'later', 'later', ctx)).toEqual({ kind: 'patch', uid: 'next', patch: { lane: 'later', before: 'later' } });
    expect(planMove(item('card:next'), 'next', null, ctx)).toEqual({ kind: 'patch', uid: 'next', patch: { before: null } });
  });

  it("pulls a Later or Next card onto today as a new row of its own, in the card's category: open with the nudge, ticked without", () => {
    expect(planMove(item('card:later'), 'progress', null, ctx)).toEqual({
      kind: 'place',
      row: { uid, addedAt: null, text: 'Write a KB', done: false, cardUid: 'later', recurringUid: null, categoryUid: 'cafe00000003' },
      nudge: true,
    });
    expect(planMove(item('card:next'), 'done', null, ctx)).toMatchObject({
      kind: 'place',
      row: { text: 'Follow up', done: true, cardUid: 'next' },
      nudge: false,
    });
  });

  it('pulls a Done card from an earlier day into In progress, continuing the card', () => {
    expect(planMove(item('card:doneTue'), 'progress', null, ctx)).toMatchObject({
      kind: 'place',
      row: { text: 'Shipped', done: false, cardUid: 'doneTue' },
      nudge: true,
    });
  });

  it("puts an earlier day's ticked row with no card back on today as a new row, which the save gives a card, with its category", () => {
    expect(planMove(earlier, 'progress', null, ctx)).toEqual({
      kind: 'place',
      row: { uid, addedAt: null, text: 'Tuesday row', done: false, cardUid: null, recurringUid: null, categoryUid: 'cafe00000002' },
      nudge: true,
    });
  });

  it("ticks and unticks today's rows between In progress and Done", () => {
    expect(planMove(open, 'done', null, ctx)).toEqual({ kind: 'tick', rowUid: open.row!.uid, done: true, cardUid: 'open00000001' });
    expect(planMove(ticked, 'progress', null, ctx)).toEqual({ kind: 'tick', rowUid: ticked.row!.uid, done: false, cardUid: 'tick00000001' });
    expect(planMove(recurring, 'done', null, ctx)).toMatchObject({ kind: 'tick', done: true, cardUid: null });
  });

  it("parks today's open row in Later or Next, card or none", () => {
    expect(planMove(open, 'later', 'later', ctx)).toEqual({ kind: 'park', row: open.row, lane: 'later', before: 'later' });
    expect(planMove(fresh, 'next', null, ctx)).toEqual({ kind: 'park', row: fresh.row, lane: 'next', before: null });
  });

  it("parks today's row whose card a later day's list holds in Next only, where it stays planned", () => {
    expect(planMove(carried, 'next', null, ctx)).toEqual({ kind: 'park', row: carried.row, lane: 'next', before: null });
    expect(planMove(carried, 'later', null, ctx)).toEqual({ kind: 'refuse', message: BOARD.planned('Carried', 'tomorrow') });
  });

  it("keeps a done item done: today's ticked row, a Done card and an earlier row moved to Later or Next give the notice, with where it was dropped and the item's category", () => {
    expect(planMove(ticked, 'later', 'later', ctx)).toEqual({ kind: 'doneStays', title: 'Ticked', categoryUid: null, lane: 'later', before: 'later' });
    expect(planMove(item('card:doneTue'), 'next', null, ctx)).toEqual({ kind: 'doneStays', title: 'Shipped', categoryUid: null, lane: 'next', before: null });
    expect(planMove(earlier, 'next', null, ctx)).toEqual({ kind: 'doneStays', title: 'Tuesday row', categoryUid: 'cafe00000002', lane: 'next', before: null });
  });

  it('refuses a recurring row in Later or Next, ticked or not, and any move of a planned card', () => {
    expect(planMove(recurring, 'later', null, ctx)).toEqual({ kind: 'refuse', message: BOARD.recurringStays('Monitor the queue') });
    const tickedRecurring = columns({ todayRows: [row(1, 'Follow-ups', { done: true, recurringUid: 'rec000000002' })] }).doneToday[0]!;
    expect(planMove(tickedRecurring, 'next', null, ctx)).toEqual({ kind: 'refuse', message: BOARD.recurringStays('Follow-ups') });
    for (const to of ['later', 'next', 'progress', 'done'] as const) {
      expect(planMove(item('card:planned'), to, null, ctx)).toEqual({ kind: 'refuse', message: BOARD.planned('Plan B', 'tomorrow') });
    }
  });

  it('does nothing for a drop where the item already is in In progress or Done', () => {
    expect(planMove(open, 'progress', null, ctx)).toBeNull();
    expect(planMove(ticked, 'done', null, ctx)).toBeNull();
    expect(planMove(item('card:doneTue'), 'done', null, ctx)).toBeNull();
  });

  it('offers every other column, none for a planned card, and no Later or Next for a recurring row', () => {
    expect(moveTargets(item('card:later'))).toEqual(['next', 'progress', 'done']);
    expect(moveTargets(open)).toEqual(['later', 'next', 'done']);
    // Done items and today's row planned later keep Later and Next, which answer with the notice.
    expect(moveTargets(ticked)).toEqual(['later', 'next', 'progress']);
    expect(moveTargets(earlier)).toEqual(['later', 'next', 'progress']);
    expect(moveTargets(carried)).toEqual(['later', 'next', 'done']);
    expect(moveTargets(recurring)).toEqual(['done']);
    expect(moveTargets(item('card:planned'))).toEqual([]);
  });
});

describe('MoveRefused', () => {
  it('is an Error carrying the line to show', () => {
    const e = new MoveRefused(BOARD.stale);
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe(BOARD.stale);
  });
});

describe('offeredLeftovers', () => {
  const rows = [
    row(1, 'No card', { categoryUid: 'cafe00000001' }),
    row(2, 'Old title', { cardUid: 'next' }),
    row(3, 'Parked', { cardUid: 'later' }),
    row(4, 'Finished', { cardUid: 'done' }),
    row(5, 'Deleted', { cardUid: 'gone00000001' }),
  ];
  const cards = [makeCard('next', 'New title', { lane: 'next' }), makeCard('later', 'Parked'), makeCard('done', 'Finished', { lane: 'done', doneAt: T0 })];

  it("brings back a row with no card as written, and one whose card is in Next under the card's title, as seeds", () => {
    expect(offeredLeftovers(rows, cards)).toEqual([
      { text: 'No card', cardUid: null, recurringUid: null, categoryUid: 'cafe00000001' },
      { text: 'New title', cardUid: 'next', recurringUid: null, categoryUid: null },
    ]);
  });

  it('offers nothing while the board has not loaded', () => {
    expect(offeredLeftovers(rows, undefined)).toBeNull();
  });
});

describe('the board as a write shows it', () => {
  const board = makeBoard(
    makeCard('l1', 'L1'),
    makeCard('l2', 'L2', { position: 2 }),
    makeCard('n1', 'N1', { lane: 'next' }),
    makeCard('d1', 'D1', { lane: 'done', position: 0, doneAt: T0 }),
  );
  const lane = (b: typeof board, l: BoardCard['lane']) =>
    b.cards
      .filter((c) => c.lane === l)
      .sort((a, b) => a.position - b.position)
      .map((c) => `${c.uid}:${c.position}`);

  it('adds a new card in its lane before the card named, or at the end', () => {
    const top = withCard(board, { uid: 'new', title: 'New', categoryUid: 'cafe00000001', lane: 'later', before: 'l1' }, T0);
    expect(lane(top, 'later')).toEqual(['new:1', 'l1:2', 'l2:3']);
    expect(top.cards.find((c) => c.uid === 'new')).toEqual(makeCard('new', 'New', { position: 1, categoryUid: 'cafe00000001' }));
    expect(lane(withCard(board, { uid: 'new', title: 'New', categoryUid: null, lane: 'next', before: null }, T0), 'next')).toEqual(['n1:1', 'new:2']);
    // A card named in another lane, or none of the board's, means the end.
    expect(lane(withCard(board, { uid: 'new', title: 'New', categoryUid: null, lane: 'later', before: 'n1' }, T0), 'later')).toEqual(['l1:1', 'l2:2', 'new:3']);
  });

  it('places a card that exists with the title and category sent, out of Done', () => {
    const parked = withCard(board, { uid: 'd1', title: 'Renamed', categoryUid: 'cafe00000001', lane: 'next', before: 'n1' }, T0);
    expect(parked.cards.find((c) => c.uid === 'd1')).toMatchObject({ title: 'Renamed', categoryUid: 'cafe00000001', lane: 'next', position: 1, doneAt: null });
    expect(lane(parked, 'next')).toEqual(['d1:1', 'n1:2']);
  });

  it('patches a title, a lane, or a place in the lane, as the server does', () => {
    expect(withPatch(board, 'l1', { title: 'Better' }).cards.find((c) => c.uid === 'l1')).toMatchObject({ title: 'Better', lane: 'later', position: 1 });
    expect(lane(withPatch(board, 'l1', { lane: 'next' }), 'next')).toEqual(['n1:1', 'l1:2']);
    expect(lane(withPatch(board, 'l2', { before: 'l1' }), 'later')).toEqual(['l2:1', 'l1:2']);
    expect(lane(withPatch(board, 'l2', { lane: 'later' }), 'later')).toEqual(['l1:1', 'l2:2']);
    // A Done card stays in Done unless a lane is named; unticked, it goes to Next.
    expect(withPatch(board, 'd1', { before: null }).cards.find((c) => c.uid === 'd1')).toMatchObject({ lane: 'done', doneAt: T0 });
    expect(withPatch(board, 'd1', { lane: 'next' }).cards.find((c) => c.uid === 'd1')).toMatchObject({ lane: 'next', position: 2, doneAt: null });
    expect(withPatch(board, 'gone', { title: 'X' })).toBe(board);
  });

  it('takes a deleted card off', () => {
    expect(withoutCard(board, 'l1').cards.map((c) => c.uid)).toEqual(['l2', 'n1', 'd1']);
  });
});
