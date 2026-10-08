import { describe, expect, it } from 'vitest';
import { HOUR_MS, parseDateKey } from '../../../shared/dates.js';
import { CATEGORY_COLORS, LIMITS } from '../../../shared/api.js';
import { makeBoard, makeCard, makeCategory, makeDay, makePriority, makeRecurring, T0 } from '../test/fixtures';
import type { BoardCard, Category, CategoryColor, Priority } from '../types';
import {
  activeCategories,
  boardColumns,
  boardFull,
  cardUidOf,
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
  needsCard,
  offeredLeftovers,
  overAnnouncement,
  planMove,
  nextColor,
  plannedFor,
  withCard,
  withCategory,
  withCategoryPatch,
  withDrag,
  withoutCard,
  withoutCategory,
  withoutRecurring,
  withPatch,
  withRecurring,
  withRecurringPatch,
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

  it("sorts nothing for today's row shown in a lane while its park is on its way, with or without its card in this copy", () => {
    expect(planMove({ ...open, column: 'later' }, 'later', 'later', ctx)).toBeNull();
    expect(planMove({ ...carried, column: 'next' }, 'next', null, ctx)).toBeNull();
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

describe('dragging', () => {
  const ctx = { today: WED };
  const NAMES: Record<ColumnId, string> = { later: 'Later', next: 'Next', progress: 'In progress', done: 'Done' };
  const cards: BoardCard[] = [
    makeCard('a', 'A'),
    makeCard('b', 'B', { position: 2 }),
    makeCard('c', 'C', { position: 3 }),
    makeCard('d', 'D', { lane: 'next' }),
    makeCard('p', 'Plan B', { lane: 'next', position: 2, listDate: THU }),
    makeCard('e', 'Shipped', { lane: 'done', doneAt: at(TUE, 9) }),
    makeCard('carried', 'Carried', { lane: 'next', position: 3, listDate: THU }),
  ];
  const todayRows = [
    row(1, 'Open', { cardUid: 'open00000001' }),
    row(2, 'Ticked', { done: true }),
    row(3, 'Monitor the queue', { recurringUid: 'rec000000001' }),
    row(4, 'Carried', { cardUid: 'carried' }),
  ];
  const c = columns({ cards, todayRows });
  const open = rowId(WED, 1);
  const ticked = rowId(WED, 2);
  const item = (id: string) => findItem(c, id)!.item;

  it('finds an item and the column showing it, the week of Done included', () => {
    expect(findItem(c, 'card:b')).toEqual({ item: c.later[1], column: 'later' });
    expect(findItem(c, 'card:e')).toEqual({ item: c.doneEarlier[0], column: 'done' });
    expect(findItem(c, ticked)).toEqual({ item: c.doneToday[0], column: 'done' });
    expect(findItem(c, 'card:gone')).toBeNull();
  });

  it('shows the dragged item in the column it is over, keeping the column it started in', () => {
    const shown = withDrag(c, 'card:a', { to: 'next', before: 'd' });
    expect(ids(shown)).toMatchObject({ later: ['card:b', 'card:c'], next: ['card:a', 'card:d', 'card:p'] });
    expect(findItem(shown, 'card:a')).toEqual({ item: c.later[0], column: 'next' });
    expect(ids(withDrag(c, 'card:a', { to: 'next', before: null })).next).toEqual(['card:d', 'card:p', 'card:a']);
    // In progress takes it at the end and Done at the top, as a move on its way shows it.
    expect(ids(withDrag(c, 'card:e', { to: 'progress', before: null }))).toMatchObject({
      progress: [open, rowId(WED, 3), rowId(WED, 4), 'card:e'],
      doneEarlier: [],
    });
    expect(ids(withDrag(c, open, { to: 'done', before: null })).doneToday).toEqual([open, ticked]);
    expect(withDrag(c, 'card:gone', { to: 'next', before: null })).toBe(c);
  });

  describe('dropTarget', () => {
    it('lands nowhere without a droppable, or for an id no column shows', () => {
      expect(dropTarget(null, 'card:a', c)).toBeNull();
      expect(dropTarget('card:gone', 'card:a', c)).toBeNull();
      expect(dropTarget('card:b', 'card:gone', c)).toBeNull();
    });

    it("goes before the card it is over in another lane, at a column's end, and anywhere in In progress or Done", () => {
      expect(dropTarget('card:d', 'card:a', c)).toEqual({ to: 'next', before: 'd' });
      expect(dropTarget('card:p', 'card:a', c)).toEqual({ to: 'next', before: 'p' });
      expect(dropTarget(columnDropId('next'), 'card:a', c)).toEqual({ to: 'next', before: null });
      expect(dropTarget(columnDropId('progress'), 'card:a', c)).toEqual({ to: 'progress', before: null });
      expect(dropTarget(columnDropId('done'), open, c)).toEqual({ to: 'done', before: null });
      expect(dropTarget(columnDropId('later'), open, c)).toEqual({ to: 'later', before: null });
      // Today's rows take no drop of their own: over one is over its column.
      expect(dropTarget(open, 'card:a', c)).toEqual({ to: 'progress', before: null });
    });

    it('takes the place of the card it is over in its own lane, as the list showed it sorting', () => {
      expect(dropTarget('card:c', 'card:a', c)).toEqual({ to: 'later', before: null });
      expect(dropTarget('card:b', 'card:a', c)).toEqual({ to: 'later', before: 'c' });
      expect(dropTarget('card:a', 'card:c', c)).toEqual({ to: 'later', before: 'a' });
      expect(dropTarget('card:p', 'card:d', c)).toEqual({ to: 'next', before: null });
    });

    it('lands where it started: over itself, or over its own column', () => {
      expect(dropTarget('card:a', 'card:a', c)).toBeNull();
      expect(dropTarget(columnDropId('later'), 'card:b', c)).toBeNull();
      expect(dropTarget(columnDropId('progress'), open, c)).toBeNull();
      expect(dropTarget(columnDropId('done'), 'card:e', c)).toBeNull();
      expect(dropTarget(columnDropId('done'), ticked, c)).toBeNull();
    });

    it('reads the columns as the drag shows them, with the item in the column it is over', () => {
      const shown = withDrag(c, 'card:a', { to: 'next', before: 'd' });
      expect(dropTarget('card:a', 'card:a', shown)).toEqual({ to: 'next', before: 'd' });
      expect(dropTarget('card:d', 'card:a', shown)).toEqual({ to: 'next', before: 'p' });
      expect(dropTarget('card:p', 'card:a', shown)).toEqual({ to: 'next', before: null });
      expect(dropTarget(columnDropId('progress'), 'card:a', withDrag(c, 'card:a', { to: 'progress', before: null }))).toEqual({
        to: 'progress',
        before: null,
      });
      // A row of today shown in Later lands there; back over In progress, it is where it started.
      const parked = withDrag(c, open, { to: 'later', before: 'a' });
      expect(dropTarget(open, open, parked)).toEqual({ to: 'later', before: 'a' });
      expect(dropTarget(columnDropId('progress'), open, parked)).toBeNull();
      // Shown in Next, then back over the top of its own lane: it goes there, though B started first after A.
      expect(dropTarget('card:a', 'card:b', withDrag(c, 'card:b', { to: 'next', before: null }))).toEqual({ to: 'later', before: 'a' });
    });
  });

  it('says how a drop ended: stayed, moved, turned down, or done and staying done', () => {
    expect(moveAnnouncement(null, item('card:a'), 'later', NAMES)).toBe(BOARD_DRAG.stays('A', 'Later'));
    expect(moveAnnouncement(null, item(open), 'progress', NAMES)).toBe(BOARD_DRAG.stays('Open', 'In progress'));
    expect(moveAnnouncement(planMove(item('card:a'), 'next', 'd', ctx), item('card:a'), 'next', NAMES)).toBe(BOARD_DRAG.moved('A', 'Next'));
    expect(moveAnnouncement(planMove(item(open), 'done', null, ctx), item(open), 'done', NAMES)).toBe(BOARD_DRAG.moved('Open', 'Done'));
    expect(moveAnnouncement(planMove(item(ticked), 'next', null, ctx), item(ticked), 'next', NAMES)).toBe(DONE_STAYS.announce('Ticked', 'Next'));
    const carried = item(rowId(WED, 4));
    expect(moveAnnouncement(planMove(carried, 'later', null, ctx), carried, 'later', NAMES)).toBe(BOARD.planned('Carried', 'tomorrow'));
    const recurring = item(rowId(WED, 3));
    expect(moveAnnouncement(planMove(recurring, 'next', null, ctx), recurring, 'next', NAMES)).toBe(BOARD.recurringStays('Monitor the queue'));
  });

  it('says where a dragged item would land: the column, and in Later or Next before which card, or back where it started', () => {
    expect(overAnnouncement(null, item('card:a'), c, NAMES)).toBe(BOARD_DRAG.overStart('A', 'Later'));
    expect(overAnnouncement({ to: 'progress', before: null }, item('card:a'), c, NAMES)).toBe(BOARD_DRAG.over('A', 'In progress'));
    expect(overAnnouncement({ to: 'next', before: 'd' }, item('card:a'), c, NAMES)).toBe(BOARD_DRAG.overBefore('A', 'Next', 'D'));
    expect(overAnnouncement({ to: 'next', before: null }, item('card:a'), c, NAMES)).toBe(BOARD_DRAG.overEnd('A', 'Next'));
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
  const tickets = 'cafe00000001';
  const kb = 'cafe00000003';
  const carried = row(1, 'Old title', { cardUid: 'next', categoryUid: tickets });
  const inNext = (categoryUid: string | null) => [makeCard('next', 'New title', { lane: 'next', categoryUid })];

  it("brings back a row whose card is in Next under the card's title and in the card's category, as a seed", () => {
    expect(offeredLeftovers([carried], inNext(kb))).toEqual([{ text: 'New title', cardUid: 'next', recurringUid: null, categoryUid: kb }]);
  });

  it("brings it back with no category once the board cleared the card's", () => {
    expect(offeredLeftovers([carried], inNext(null))).toEqual([{ text: 'New title', cardUid: 'next', recurringUid: null, categoryUid: null }]);
  });

  it('brings back a row with no card as written, and leaves one whose card was moved to Later, finished or deleted', () => {
    const rows = [
      row(1, 'No card', { categoryUid: tickets }),
      row(2, 'Parked', { cardUid: 'later', categoryUid: tickets }),
      row(3, 'Finished', { cardUid: 'done', categoryUid: tickets }),
      row(4, 'Deleted', { cardUid: 'gone00000001', categoryUid: tickets }),
    ];
    const cards = [makeCard('later', 'Parked', { categoryUid: kb }), makeCard('done', 'Finished', { lane: 'done', doneAt: T0, categoryUid: kb })];
    expect(offeredLeftovers(rows, cards)).toEqual([{ text: 'No card', cardUid: null, recurringUid: null, categoryUid: tickets }]);
  });

  it('offers nothing while the board has not loaded', () => {
    expect(offeredLeftovers([carried], undefined)).toBeNull();
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

  it('patches a category onto a card, or off it, and keeps it when the patch leaves it out', () => {
    const tagged = withPatch(board, 'l1', { categoryUid: 'cafe00000001' });
    expect(tagged.cards.find((c) => c.uid === 'l1')).toMatchObject({ categoryUid: 'cafe00000001', lane: 'later', position: 1 });
    expect(withPatch(tagged, 'l1', { title: 'Kept' }).cards.find((c) => c.uid === 'l1')?.categoryUid).toBe('cafe00000001');
    expect(withPatch(tagged, 'l1', { categoryUid: null }).cards.find((c) => c.uid === 'l1')?.categoryUid).toBeNull();
  });

  it('takes a deleted card off', () => {
    expect(withoutCard(board, 'l1').cards.map((c) => c.uid)).toEqual(['l2', 'n1', 'd1']);
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

    describe('recurring priorities', () => {
      const queue = makeRecurring('rec000000001', 'Monitor the queue');
      const follow = makeRecurring('rec000000002', 'Follow-ups', { weekdays: [1, 3, 5] });
      const withTwo = { ...board, recurring: [queue, follow] };

      it('adds one after the others, its weekdays ascending, as the server answers them', () => {
        const added = withRecurring(withTwo, makeRecurring('rec000000003', 'Timesheet', { weekdays: [5, 1] }));
        expect(added.recurring).toEqual([queue, follow, makeRecurring('rec000000003', 'Timesheet', { weekdays: [1, 5] })]);
        expect(added.categories).toBe(board.categories);
      });

      it('leaves the board as it is when the uid is held already, as the server does for a retry', () => {
        expect(withRecurring(withTwo, makeRecurring('rec000000001', 'Other', { weekdays: [7] }))).toBe(withTwo);
      });

      it('changes the fields sent, keeps the ones left out, and puts the weekdays in order', () => {
        expect(withRecurringPatch(withTwo, follow.uid, { title: 'Chase replies' }).recurring).toEqual([queue, { ...follow, title: 'Chase replies' }]);
        expect(withRecurringPatch(withTwo, follow.uid, { categoryUid: 'cat000000001' }).recurring[1]).toEqual({ ...follow, categoryUid: 'cat000000001' });
        expect(withRecurringPatch(withTwo, follow.uid, { weekdays: [7, 2, 4] }).recurring[1]).toEqual({ ...follow, weekdays: [2, 4, 7] });
        expect(withRecurringPatch(withTwo, queue.uid, { categoryUid: null }).recurring[0]).toEqual(queue);
        const filed = { ...withTwo, recurring: [{ ...queue, categoryUid: 'cat000000001' }] };
        expect(withRecurringPatch(filed, queue.uid, { categoryUid: null }).recurring[0]).toEqual(queue);
      });

      it('takes one off', () => {
        expect(withoutRecurring(withTwo, queue.uid).recurring).toEqual([follow]);
        expect(withoutRecurring(withTwo, 'gone00000001').recurring).toEqual([queue, follow]);
      });
    });
  });
});
