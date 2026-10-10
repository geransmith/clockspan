// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { BOARD_LIMITS } from '../../../shared/api.js';
import { MINUTE_MS } from '../../../shared/dates.js';
import { MAX_PRIORITIES } from '../../../shared/settings.js';
import { warnSaveFailed } from '../lib/alerts';
import { MoveRefused, withCategory, withCategoryPatch, withItem, withItemPatch, withoutCategory, withoutItem, type StoreMove } from '../lib/board';
import { ADD_PRIORITY_FAILED, BOARD, SAVE_FAILED } from '../lib/copy';
import {
  answered,
  apiError,
  begin,
  deferredAnswer,
  makeBoard,
  makeCard,
  makeCategory,
  makeDay,
  makePriority,
  makeRecurring,
  makeSettings,
  serveRange,
  settle,
  SettingsAndDays,
  setVisibility,
  T0,
  TODAY,
  YESTERDAY,
} from '../test/hooks';
import type { Board, Priority } from '../types';
import { useBoardState, useBoardStore, useCategoryPick } from './useBoard';
import { useDay, useDays, useDayStore } from './useDay';
import { useLeftOpen } from './useLeftOpen';

vi.mock('../api');
vi.mock('../lib/alerts');

const TOMORROW = '2026-09-29';

/** The board, its store and the day store, with today loaded as the board view loads it. */
function renderBoard({ strict = false, today = true } = {}) {
  return renderHook(
    () => {
      if (today) useDay(TODAY);
      return {
        ...useBoardState(),
        store: useBoardStore(),
        days: useDayStore(),
        heldDays: useDays().days,
        generation: useDays().generation,
      };
    },
    { wrapper: SettingsAndDays, reactStrictMode: strict },
  );
}

/** The server's board, which each board route below changes as the real one does. */
let onServer: Board;
/** Each day's list on the server, stored as each PUT sends it. */
let lists: Record<string, Priority[]>;

const putCalls = () => vi.mocked(api.putPriorities).mock.calls.map(([date, list]) => ({ date, texts: list.map((p) => p.text) }));
const LANE_ORDER = { later: 0, next: 1 };
/** The board's tasks' titles in Later then Next, each by position, then the rest in the order sent. */
const shownTexts = (b: Board | undefined) =>
  b && [...b.cards].sort((x, y) => (x.lane ? LANE_ORDER[x.lane] : 2) - (y.lane ? LANE_ORDER[y.lane] : 2) || x.position - y.position).map((c) => c.title);
const callOrder = (fn: (...args: never[]) => unknown, n = 0) => vi.mocked(fn).mock.invocationCallOrder[n]!;

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  onServer = makeBoard(makeCard('later0000001', 'Write a KB'), makeCard('next00000001', 'Follow up', { lane: 'next' }));
  lists = {};
  vi.mocked(api.getSettings).mockResolvedValue(answered(makeSettings()));
  vi.mocked(api.getDay).mockImplementation((date) => Promise.resolve(answered(makeDay(date, { priorities: lists[date] ?? [] }))));
  vi.mocked(api.putPriorities).mockImplementation((date, list) => Promise.resolve(answered({ priorities: (lists[date] = list) })));
  vi.mocked(api.getBoard).mockImplementation(() => Promise.resolve(answered(onServer)));
  vi.mocked(api.addItem).mockImplementation((item) => Promise.resolve(answered((onServer = withItem(onServer, item, T0)))));
  vi.mocked(api.editItem).mockImplementation((uid, patch) => Promise.resolve(answered((onServer = withItemPatch(onServer, uid, patch)))));
  vi.mocked(api.deleteItem).mockImplementation((uid) => Promise.resolve(answered((onServer = withoutItem(onServer, uid)))));
  vi.mocked(api.addCategory).mockImplementation((c) => Promise.resolve(answered((onServer = withCategory(onServer, c)))));
  vi.mocked(api.patchCategory).mockImplementation((uid, patch) => Promise.resolve(answered((onServer = withCategoryPatch(onServer, uid, patch)))));
  vi.mocked(api.deleteCategory).mockImplementation((uid) => Promise.resolve(answered((onServer = withoutCategory(onServer, uid)))));
});

describe('reading the board', () => {
  it('reads at once without waiting for the settings, and once under StrictMode', async () => {
    vi.mocked(api.getSettings).mockReturnValue(deferredAnswer<ReturnType<typeof makeSettings>>().promise);
    const { result } = renderBoard({ strict: true });
    await settle();
    expect(api.getBoard).toHaveBeenCalledTimes(1);
    expect(result.current.failed).toBe(false);
    expect(shownTexts(result.current.board)).toEqual(['Write a KB', 'Follow up']);
  });

  it('reads every minute and when the tab comes back', async () => {
    renderBoard();
    await settle();
    expect(api.getBoard).toHaveBeenCalledTimes(1);
    await settle(MINUTE_MS);
    expect(api.getBoard).toHaveBeenCalledTimes(2);
    await settle(10_000);
    act(() => setVisibility('hidden'));
    act(() => setVisibility('visible'));
    expect(api.getBoard).toHaveBeenCalledTimes(3);
    await settle();
  });

  it('marks a failed first read, keeps the board through a later one, and Try again clears it', async () => {
    vi.mocked(api.getBoard).mockRejectedValueOnce(new Error('offline'));
    const { result } = renderBoard();
    await settle();
    expect(result.current).toMatchObject({ failed: true, board: undefined });
    await act(() => result.current.store.load());
    expect(result.current.failed).toBe(false);
    expect(shownTexts(result.current.board)).toEqual(['Write a KB', 'Follow up']);
    vi.mocked(api.getBoard).mockRejectedValueOnce(new Error('offline'));
    await act(() => result.current.store.load());
    expect(result.current.failed).toBe(false);
    expect(shownTexts(result.current.board)).toEqual(['Write a KB', 'Follow up']);
  });

  it('keeps the board object when a read brings back the same board, and never lets a read sent before a write undo it', async () => {
    const { result } = renderBoard();
    await settle();
    const before = result.current.board;
    await act(() => result.current.store.load());
    expect(result.current.board).toBe(before);

    const old = deferredAnswer<Board>();
    vi.mocked(api.getBoard).mockReturnValueOnce(old.promise);
    act(() => void result.current.store.load());
    const stale = onServer;
    vi.mocked(api.addItem).mockImplementationOnce((item) => Promise.resolve(answered((onServer = withItem(onServer, item, T0)), 1)));
    await act(() => result.current.store.addItem({ uid: 'new000000001', title: 'Captured', categoryUid: null, lane: 'later', before: null }));
    old.resolve(stale);
    await settle();
    expect(shownTexts(result.current.board)).toEqual(['Write a KB', 'Captured', 'Follow up']);
  });

  it('offers the recurring priorities the server has confirmed, never one whose create is still out', async () => {
    const queue = makeRecurring('rcur00000001', 'Monitor the queue');
    onServer = { ...onServer, recurring: [queue] };
    const { result } = renderBoard();
    await settle();
    expect(result.current.confirmedRecurring).toEqual([queue]);
    const created = deferredAnswer<Board>();
    vi.mocked(api.addItem).mockReturnValueOnce(created.promise);
    const timesheet = { uid: 'rcur00000002', title: 'Timesheet', categoryUid: null, weekdays: [5] };
    act(() => {
      void result.current.store.addItem(timesheet);
      void result.current.store.editItem(queue.uid, { title: 'Watch the queue' });
    });
    expect(result.current.board?.recurring.map((r) => r.title)).toEqual(['Watch the queue', 'Timesheet']);
    // A rename on its way shows; a recurring priority the server doesn't hold yet isn't offered.
    expect(result.current.confirmedRecurring?.map((r) => r.title)).toEqual(['Watch the queue']);
    created.resolve((onServer = withItem(onServer, timesheet, T0)));
    await settle();
    expect(result.current.confirmedRecurring?.map((r) => r.title)).toEqual(['Watch the queue', 'Timesheet']);
  });

  it('offers Up next the cards the server has confirmed, never one whose create is still out', async () => {
    const { result } = renderBoard();
    await settle();
    expect(result.current.confirmedCards).toEqual(onServer.cards);
    const created = deferredAnswer<Board>();
    vi.mocked(api.addItem).mockReturnValueOnce(created.promise);
    const rota = { uid: 'next00000002', title: 'Draft the rota', categoryUid: null, lane: 'next' as const, before: null };
    act(() => {
      void result.current.store.addItem(rota);
      void result.current.store.editItem('next00000001', { title: 'Follow up on the SLA' });
    });
    expect(shownTexts(result.current.board)).toEqual(['Write a KB', 'Follow up on the SLA', 'Draft the rota']);
    // A rename on its way shows; a card the server doesn't hold yet isn't offered.
    expect(result.current.confirmedCards?.map((c) => c.title)).toEqual(['Write a KB', 'Follow up on the SLA']);
    created.resolve((onServer = withItem(onServer, rota, T0)));
    await settle();
    expect(result.current.confirmedCards?.map((c) => c.title)).toEqual(['Write a KB', 'Follow up on the SLA', 'Draft the rota']);
  });

  it('offers no recurring priority or card before the first read', async () => {
    vi.mocked(api.getBoard).mockReturnValueOnce(new Promise(() => {}));
    const { result } = renderBoard();
    await settle();
    expect(result.current.confirmedRecurring).toBeUndefined();
    expect(result.current.confirmedCards).toBeUndefined();
  });
});

describe('task writes', () => {
  it('show at once and go out one after another', async () => {
    const first = deferredAnswer<Board>();
    vi.mocked(api.addItem).mockReturnValueOnce(first.promise);
    const { result } = renderBoard();
    await settle();
    const captured = { uid: 'one000000001', title: 'One', categoryUid: null, lane: 'later' as const, before: 'later0000001' };
    act(() => {
      void result.current.store.addItem(captured);
      void result.current.store.editItem('next00000001', { lane: 'later', before: null });
    });
    expect(shownTexts(result.current.board)).toEqual(['One', 'Write a KB', 'Follow up']);
    expect(result.current.board?.cards.find((c) => c.uid === 'next00000001')?.lane).toBe('later');
    expect(api.editItem).not.toHaveBeenCalled();
    first.resolve((onServer = withItem(onServer, captured, T0)));
    await settle();
    expect(api.editItem).toHaveBeenCalledExactlyOnceWith('next00000001', { lane: 'later', before: null });
    expect(result.current.board).toEqual(onServer);
  });

  it("refuse a new task in a lane once Later and Next are full, sending nothing, with the board's line", async () => {
    onServer = makeBoard(...Array.from({ length: BOARD_LIMITS.openCards }, (_, i) => makeCard(`full${i}`.padEnd(12, 'x'), `Task ${i}`, { position: i + 1 })));
    const { result } = renderBoard();
    await settle();
    await expect(
      act(() => result.current.store.addItem({ uid: 'new000000001', title: 'Captured', categoryUid: null, lane: 'next', before: null })),
    ).rejects.toThrow(new MoveRefused(BOARD.full));
    expect(api.addItem).not.toHaveBeenCalled();
    expect(result.current.board?.cards).toHaveLength(BOARD_LIMITS.openCards);
    // A recurring priority takes no lane.
    await act(() => result.current.store.addItem(makeRecurring('rcur00000001', 'Timesheet')));
    expect(api.addItem).toHaveBeenCalledOnce();
  });

  it('take a failed change off, reject, and read the board again: a refusal of any kind', async () => {
    const { result } = renderBoard();
    await settle();
    vi.mocked(api.addItem).mockRejectedValueOnce(new Error('offline'));
    await expect(
      act(() => result.current.store.addItem({ uid: 'lost00000001', title: 'Lost', categoryUid: null, lane: 'next', before: null })),
    ).rejects.toThrow('offline');
    expect(shownTexts(result.current.board)).toEqual(['Write a KB', 'Follow up']);
    expect(api.getBoard).toHaveBeenCalledTimes(2);
    // A task deleted on another device.
    vi.mocked(api.editItem).mockRejectedValueOnce(apiError(404));
    const err = await act(() => result.current.store.editItem('later0000001', { title: 'Renamed' }).catch((e: unknown) => e));
    expect(err).toMatchObject({ status: 404 });
    expect(err).not.toBeInstanceOf(MoveRefused);
    expect(shownTexts(result.current.board)).toEqual(['Write a KB', 'Follow up']);
    expect(api.getBoard).toHaveBeenCalledTimes(3);
    expect(api.getDay).toHaveBeenCalledTimes(1);
  });

  it('read again every held day that names a task given a new name or category, and the ranges on screen, and nothing after a lane or weekdays', async () => {
    const queue = makeRecurring('rcur00000001', 'Monitor the queue');
    onServer = { ...onServer, recurring: [queue] };
    const row = makePriority(1, 'Monitor the queue', { uid: queue.uid, recurring: true });
    lists[TODAY] = [row];
    lists[YESTERDAY] = [row];
    lists[TOMORROW] = [makePriority(1, 'Email')];
    const { result } = renderBoard();
    await settle();
    for (const d of [YESTERDAY, TOMORROW]) await act(() => result.current.days.load(d));
    const reads = () =>
      vi
        .mocked(api.getDay)
        .mock.calls.map(([d]) => d)
        .sort();
    vi.mocked(api.getDay).mockClear();
    await act(() => result.current.store.editItem('next00000001', { lane: 'later', before: null }));
    await act(() => result.current.store.editItem(queue.uid, { weekday: { day: 3, on: false } }));
    await settle();
    expect(api.getDay).not.toHaveBeenCalled();
    expect(result.current.generation).toBe(0);
    // A task no held day names: only the ranges ask again.
    await act(() => result.current.store.editItem('later0000001', { title: 'Write the KB' }));
    await settle();
    expect(api.getDay).not.toHaveBeenCalled();
    expect(result.current.generation).toBe(1);
    // The server renamed it on every day: each held day's read takes the new name.
    lists[TODAY] = lists[YESTERDAY] = [{ ...row, text: 'Watch the queue' }];
    await act(() => result.current.store.editItem(queue.uid, { title: 'Watch the queue' }));
    await settle();
    expect(reads()).toEqual([YESTERDAY, TODAY]);
    expect(result.current.heldDays[YESTERDAY]?.priorities[0]?.text).toBe('Watch the queue');
    expect(result.current.heldDays[TODAY]?.priorities[0]?.text).toBe('Watch the queue');
    expect(result.current.generation).toBe(2);
    vi.mocked(api.getDay).mockClear();
    await act(() => result.current.store.editItem(queue.uid, { categoryUid: null }));
    await settle();
    expect(reads()).toEqual([YESTERDAY, TODAY]);
    expect(result.current.generation).toBe(3);
  });
});

describe('moves', () => {
  const move = (result: ReturnType<typeof renderBoard>['result'], m: StoreMove) => act(() => result.current.store.move(m));
  /** A task's row as a pull builds it: the task itself, stamped by the store as it goes out. */
  const pulled = (uid: string, text: string, done = false): Omit<Priority, 'position'> => ({ ...makePriority(0, text, { uid, done, addedAt: null }) });

  it("pull a task onto today's list inside the job, as itself, and the next board write waits for that save", async () => {
    lists[TODAY] = [makePriority(1, 'Report')];
    const { result } = renderBoard();
    await settle();
    const save = deferredAnswer<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(save.promise);
    act(() => {
      void result.current.store.move({ kind: 'place', row: pulled('later0000001', 'Write a KB'), nudge: true });
      void result.current.store.addItem({ uid: 'after0000001', title: 'After', categoryUid: null, lane: 'next', before: null });
    });
    await settle();
    expect(putCalls()).toEqual([{ date: TODAY, texts: ['Report', 'Write a KB', ''] }]);
    // Stamped as it goes out: an entry new to today's list.
    expect(vi.mocked(api.putPriorities).mock.calls[0]![1][1]).toMatchObject({ uid: 'later0000001', addedAt: T0 });
    expect(api.addItem).not.toHaveBeenCalled();
    save.resolve({ priorities: vi.mocked(api.putPriorities).mock.calls[0]![1] });
    await settle();
    expect(api.addItem).toHaveBeenCalledTimes(1);
  });

  it('put a task in Done as a ticked row of today', async () => {
    const { result } = renderBoard();
    await settle();
    await move(result, { kind: 'place', row: pulled('next00000001', 'Follow up', true), nudge: false });
    expect(lists[TODAY]![0]).toMatchObject({ uid: 'next00000001', text: 'Follow up', done: true });
  });

  it('refuse a pull onto a full list or one not loaded, and say when the save failed', async () => {
    lists[TODAY] = Array.from({ length: MAX_PRIORITIES }, (_, i) => makePriority(i + 1, `Row ${i + 1}`, { uid: `task${i}`.padEnd(12, 'x') }));
    const { result } = renderBoard();
    await settle();
    const place = (uid: string): StoreMove => ({ kind: 'place', row: pulled(uid, 'X'), nudge: true });
    await expect(move(result, place('later0000001'))).rejects.toThrow(new MoveRefused(ADD_PRIORITY_FAILED.full));
    lists[TODAY] = [];
    await act(() => result.current.days.load(TODAY));
    vi.mocked(api.putPriorities).mockRejectedValueOnce(new Error('offline'));
    await expect(move(result, place('later0000001'))).rejects.toThrow(SAVE_FAILED.title);
    expect(warnSaveFailed).toHaveBeenCalledOnce();

    const { result: noDay } = renderBoard({ today: false });
    await settle();
    const err = await act(() => noDay.current.store.move(place('next00000001')).catch((e: unknown) => e));
    expect(err).toEqual(new MoveRefused(ADD_PRIORITY_FAILED.notLoaded));
    expect(err).toBeInstanceOf(MoveRefused);
  });

  it("refuse a tick or a rename while today's list is not loaded", async () => {
    const { result } = renderBoard({ today: false });
    await settle();
    await expect(move(result, { kind: 'tick', uid: 'row000000001', done: true })).rejects.toThrow(new MoveRefused(ADD_PRIORITY_FAILED.notLoaded));
    await expect(act(() => result.current.store.editRow('row000000001', { text: 'New' }))).rejects.toThrow(new MoveRefused(ADD_PRIORITY_FAILED.notLoaded));
  });

  it("tick and untick a row of today's list, and leave a row gone meanwhile alone", async () => {
    lists[TODAY] = [makePriority(1, 'Report')];
    const { result } = renderBoard();
    await settle();
    const uid = lists[TODAY]![0]!.uid!;
    await move(result, { kind: 'tick', uid, done: true });
    expect(lists[TODAY]![0]!.done).toBe(true);
    await move(result, { kind: 'tick', uid, done: false });
    expect(lists[TODAY]![0]!.done).toBe(false);
    await move(result, { kind: 'tick', uid: 'gone00000001', done: true });
    expect(api.putPriorities).toHaveBeenCalledTimes(2);
  });

  it('rename a row of today, or give it a category or a note, through the list', async () => {
    lists[TODAY] = [makePriority(1, 'Report')];
    const { result } = renderBoard();
    await settle();
    const uid = lists[TODAY]![0]!.uid!;
    await act(() => result.current.store.editRow(uid, { text: 'Report v2' }));
    expect(putCalls()).toEqual([{ date: TODAY, texts: ['Report v2', '', ''] }]);
    await act(() => result.current.store.editRow(uid, { categoryUid: 'cafe00000001' }));
    await act(() => result.current.store.editRow(uid, { note: 'Ask Kim' }));
    expect(lists[TODAY]![0]).toMatchObject({ text: 'Report v2', categoryUid: 'cafe00000001', note: 'Ask Kim' });
    expect(api.editItem).not.toHaveBeenCalled();
  });

  it("keep today's row's new name when a board read sent before its save answers after it", async () => {
    const queue = makeRecurring('rcur00000001', 'Monitor the queue');
    onServer = { ...onServer, recurring: [queue] };
    lists[TODAY] = [makePriority(1, 'Monitor the queue', { uid: queue.uid, recurring: true })];
    const { result } = renderBoard();
    await settle();
    const old = deferredAnswer<Board>();
    vi.mocked(api.getBoard).mockReturnValueOnce(old.promise);
    act(() => void result.current.store.load());
    vi.mocked(api.putPriorities).mockImplementationOnce((date, list) => Promise.resolve(answered({ priorities: (lists[date] = list) }, 1)));
    await act(() => result.current.store.editRow(queue.uid, { text: 'Watch the queue' }));
    // The read left before the save: the old name, at revision 0.
    old.resolve(onServer);
    await settle();
    expect(result.current.board?.recurring[0]?.title).toBe('Watch the queue');
  });

  it("rename a row gone from today's list meanwhile, or give it a category or a note, through its task", async () => {
    const { result } = renderBoard();
    await settle();
    await act(() => result.current.store.editRow('later0000001', { text: 'Write the KB' }));
    await act(() => result.current.store.editRow('later0000001', { categoryUid: 'cafe00000001' }));
    await act(() => result.current.store.editRow('later0000001', { note: 'Ask Kim' }));
    expect(vi.mocked(api.editItem).mock.calls).toEqual([
      ['later0000001', { title: 'Write the KB' }],
      ['later0000001', { categoryUid: 'cafe00000001' }],
      ['later0000001', { note: 'Ask Kim' }],
    ]);
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(result.current.board?.cards.find((c) => c.uid === 'later0000001')).toMatchObject({
      title: 'Write the KB',
      categoryUid: 'cafe00000001',
      note: 'Ask Kim',
    });
    expect(result.current.generation).toBe(3);
  });

  it('send a move made before midnight against that day, though its job runs after', async () => {
    lists[TODAY] = [makePriority(1, 'Report')];
    const { result } = renderBoard();
    await settle();
    const uid = lists[TODAY]![0]!.uid!;
    const first = deferredAnswer<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(first.promise);
    act(() => {
      void result.current.store.move({ kind: 'place', row: pulled('later0000001', 'Write a KB'), nudge: true });
      void result.current.store.move({ kind: 'tick', uid, done: true });
    });
    await settle();
    vi.setSystemTime(new Date(2026, 8, 29, 0, 1));
    first.resolve({ priorities: (lists[TODAY] = vi.mocked(api.putPriorities).mock.calls[0]![1]) });
    await settle();
    expect(putCalls().map((c) => c.date)).toEqual([TODAY, TODAY]);
    expect(lists[TODAY]![0]).toMatchObject({ uid, done: true });
  });

  it('change a task through a patch move as an edit', async () => {
    const { result } = renderBoard();
    await settle();
    await move(result, { kind: 'patch', uid: 'later0000001', patch: { lane: 'next', before: null } });
    expect(api.editItem).toHaveBeenCalledWith('later0000001', { lane: 'next', before: null });
    expect(result.current.board?.cards.find((c) => c.uid === 'later0000001')?.lane).toBe('next');
  });

  it("refuse a lane for a task that takes room there once Later and Next are full, sending nothing, with the board's line", async () => {
    const full = Array.from({ length: BOARD_LIMITS.openCards }, (_, i) => makeCard(`full${i}`.padEnd(12, 'x'), `Task ${i}`, { position: i + 1 }));
    onServer = makeBoard(...full, makeCard('left00000001', 'Left open', { lane: null, listDate: YESTERDAY }));
    const { result } = renderBoard();
    await settle();
    await expect(move(result, { kind: 'patch', uid: 'left00000001', patch: { lane: 'next', before: null } })).rejects.toThrow(new MoveRefused(BOARD.full));
    expect(api.editItem).not.toHaveBeenCalled();
    // A task in a lane already takes no more room.
    await move(result, { kind: 'patch', uid: full[0]!.uid, patch: { lane: 'next', before: null } });
    await move(result, { kind: 'patch', uid: full[1]!.uid, patch: { before: null } });
    expect(api.editItem).toHaveBeenCalledTimes(2);
  });

  describe('park', () => {
    it("places the task once today's save still out has landed, then takes the row off today's list", async () => {
      lists[TODAY] = [makePriority(1, 'Report')];
      const { result } = renderBoard();
      await settle();
      // Typed a moment ago: the save that makes the task is still out.
      const typed = makePriority(2, 'Email', { uid: 'typed0000001', listed: 0 });
      const save = deferredAnswer<{ priorities: Priority[] }>();
      vi.mocked(api.putPriorities).mockReturnValueOnce(save.promise);
      act(() => void result.current.days.setPriorities(TODAY, [lists[TODAY]![0]!, typed], lists[TODAY]!));
      const parked = begin(() => result.current.store.move({ kind: 'park', uid: 'typed0000001', lane: 'later', before: 'later0000001' }));
      await settle();
      expect(api.editItem).not.toHaveBeenCalled();
      onServer = makeBoard(...onServer.cards, makeCard('typed0000001', 'Email', { lane: null, listDate: TODAY }));
      await act(() => result.current.store.load());
      const placed = deferredAnswer<Board>();
      vi.mocked(api.editItem).mockReturnValueOnce(placed.promise);
      save.resolve({ priorities: (lists[TODAY] = vi.mocked(api.putPriorities).mock.calls[0]![1]) });
      await settle();
      expect(api.editItem).toHaveBeenCalledExactlyOnceWith('typed0000001', { lane: 'later', before: 'later0000001' });
      // Shown in Later while the board places it; the row leaves today's list once that is done.
      expect(result.current.board?.cards.find((c) => c.uid === 'typed0000001')).toMatchObject({ lane: 'later', position: 1 });
      expect(api.putPriorities).toHaveBeenCalledTimes(1);
      placed.resolve((onServer = withItemPatch(onServer, 'typed0000001', { lane: 'later', before: 'later0000001' })));
      await act(() => parked);
      // The list as the card pads it, less the row: the card pads it again on screen.
      expect(putCalls().map((c) => c.texts)).toEqual([
        ['Report', 'Email'],
        ['Report', '', ''],
      ]);
      expect(callOrder(api.editItem)).toBeLessThan(callOrder(api.putPriorities, 1));
      expect(result.current.board?.cards.find((c) => c.uid === 'typed0000001')).toMatchObject({ lane: 'later', position: 1 });
    });

    it('takes nothing off when placing the task fails: offline, deleted on another device, or the server at its cap', async () => {
      lists[TODAY] = [makePriority(1, 'Report', { uid: 'later0000001' })];
      const { result } = renderBoard();
      await settle();
      for (const refusal of [new Error('offline'), apiError(404), apiError(400)]) {
        vi.mocked(api.editItem).mockRejectedValueOnce(refusal);
        await expect(move(result, { kind: 'park', uid: 'later0000001', lane: 'next', before: null })).rejects.toBe(refusal);
      }
      expect(api.putPriorities).not.toHaveBeenCalled();
      expect(lists[TODAY]!.map((p) => p.text)).toEqual(['Report']);
    });

    it('refuses with the full line, sending nothing, when the task would take room in full lanes', async () => {
      onServer = makeBoard(...Array.from({ length: BOARD_LIMITS.openCards }, (_, i) => makeCard(`full${i}`.padEnd(12, 'x'), `Task ${i}`, { position: i + 1 })));
      lists[TODAY] = [makePriority(1, 'Typed')];
      const { result } = renderBoard();
      await settle();
      await expect(move(result, { kind: 'park', uid: lists[TODAY]![0]!.uid!, lane: 'later', before: null })).rejects.toThrow(new MoveRefused(BOARD.full));
      expect(api.editItem).not.toHaveBeenCalled();
      expect(api.putPriorities).not.toHaveBeenCalled();
    });

    it('places the same task again on a retry after a failed removal, and leaves a row gone meanwhile alone', async () => {
      lists[TODAY] = [makePriority(1, 'Report', { uid: 'later0000001' })];
      const { result } = renderBoard();
      await settle();
      vi.mocked(api.putPriorities).mockRejectedValueOnce(new Error('offline'));
      const park: StoreMove = { kind: 'park', uid: 'later0000001', lane: 'next', before: null };
      await expect(move(result, park)).rejects.toThrow(SAVE_FAILED.title);
      expect(lists[TODAY]!.map((p) => p.text)).toEqual(['Report']);
      await move(result, park);
      expect(vi.mocked(api.editItem).mock.calls.map(([uid]) => uid)).toEqual(['later0000001', 'later0000001']);
      expect(lists[TODAY]!.map((p) => p.text)).toEqual(['', '', '']);
      // Gone from the list now: placed, nothing more sent.
      await move(result, { ...park, lane: 'later' });
      expect(api.editItem).toHaveBeenCalledTimes(3);
      expect(api.putPriorities).toHaveBeenCalledTimes(2);
    });

    it('reads the board again once the row is off, so a done task pulled back onto today shows done again', async () => {
      const done = makeCard('done00000001', 'Shipped', { lane: null, listDate: YESTERDAY, listDone: true });
      onServer = makeBoard(...onServer.cards, { ...done, listDate: TODAY, listDone: false });
      lists[TODAY] = [makePriority(1, 'Shipped', { uid: done.uid, listed: 2 })];
      const { result } = renderBoard();
      await settle();
      vi.mocked(api.putPriorities).mockImplementationOnce((date, list) => {
        onServer = makeBoard(...onServer.cards.map((c) => (c.uid === done.uid ? { ...c, listDate: YESTERDAY, listDone: true } : c)));
        return Promise.resolve(answered({ priorities: (lists[date] = list) }));
      });
      await move(result, { kind: 'park', uid: done.uid, lane: 'next', before: null });
      await settle();
      expect(api.getBoard).toHaveBeenCalledTimes(2);
      expect(result.current.board?.cards.find((c) => c.uid === done.uid)).toMatchObject({ lane: 'next', listDone: true });
    });

    it('refuses a row whose list is not loaded once it is placed', async () => {
      const { result } = renderBoard({ today: false });
      await settle();
      await expect(move(result, { kind: 'park', uid: 'later0000001', lane: 'next', before: null })).rejects.toThrow(
        new MoveRefused(ADD_PRIORITY_FAILED.notLoaded),
      );
    });
  });
});

describe('deleteItem', () => {
  it("takes the task off the board at once, deletes it once today's save is in, which takes it off every day, and reads its days again", async () => {
    const report = makePriority(1, 'Report', { uid: 'later0000001', listed: 2 });
    lists[TODAY] = [report];
    lists[YESTERDAY] = [report];
    const { result } = renderBoard();
    await settle();
    await act(() => result.current.days.load(YESTERDAY));
    await act(() => result.current.days.load(TOMORROW));
    // A task typed a moment ago: today's save is still out.
    const save = deferredAnswer<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(save.promise);
    act(() => void result.current.days.setPriorities(TODAY, [report, makePriority(2, 'Email')], [report]));
    const deleted = begin(() => result.current.store.deleteItem('later0000001'));
    expect(shownTexts(result.current.board)).toEqual(['Follow up']);
    await settle();
    expect(api.deleteItem).not.toHaveBeenCalled();
    save.resolve({ priorities: (lists[TODAY] = vi.mocked(api.putPriorities).mock.calls[0]![1]) });
    // The server took it off every day, today's list included, and kept its tombstone.
    vi.mocked(api.getDay).mockClear();
    lists[TODAY] = lists[TODAY].filter((p) => p.uid !== report.uid);
    lists[YESTERDAY] = [];
    await act(() => deleted);
    await settle();
    expect(api.deleteItem).toHaveBeenCalledExactlyOnceWith('later0000001');
    expect(api.putPriorities).toHaveBeenCalledOnce();
    expect(
      vi
        .mocked(api.getDay)
        .mock.calls.map(([d]) => d)
        .sort(),
    ).toEqual([YESTERDAY, TODAY]);
    expect(result.current.heldDays[TODAY]?.priorities.map((p) => p.text)).toEqual(['Email']);
    expect(result.current.heldDays[YESTERDAY]?.priorities).toEqual([]);
    expect(result.current.generation).toBe(1);
    expect(shownTexts(result.current.board)).toEqual(['Follow up']);
  });

  it("waits for the sheet's save that took the row off today, then deletes", async () => {
    lists[TODAY] = [makePriority(1, 'Report', { uid: 'task00000001', listed: 2 })];
    const { result } = renderBoard();
    await settle();
    const save = deferredAnswer<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(save.promise);
    // Delete everywhere on the sheet: its × save first, then the job.
    act(() => void result.current.days.setPriorities(TODAY, [], lists[TODAY]!));
    const deleted = begin(() => result.current.store.deleteItem('task00000001'));
    await settle();
    expect(api.deleteItem).not.toHaveBeenCalled();
    save.resolve({ priorities: (lists[TODAY] = []) });
    await act(() => deleted);
    expect(api.deleteItem).toHaveBeenCalledExactlyOnceWith('task00000001');
    expect(api.putPriorities).toHaveBeenCalledTimes(1);
  });

  it("sends its delete without waiting for another day's save still out", async () => {
    const { result } = renderBoard();
    await settle();
    await act(() => result.current.days.load(YESTERDAY));
    vi.mocked(api.putPriorities).mockReturnValueOnce(new Promise(() => {}));
    act(() => void result.current.days.setPriorities(YESTERDAY, [makePriority(1, 'Write a KB', { uid: 'later0000001', done: true })], []));
    await act(() => result.current.store.deleteItem('later0000001'));
    expect(api.deleteItem).toHaveBeenCalledExactlyOnceWith('later0000001');
  });

  it('counts a 404 as done: another device deleted the task already', async () => {
    const { result } = renderBoard();
    await settle();
    // A read that still has the task, sent before the delete was answered, doesn't bring it back.
    const old = deferredAnswer<Board>();
    vi.mocked(api.getBoard).mockReturnValueOnce(old.promise);
    act(() => void result.current.store.load());
    vi.mocked(api.deleteItem).mockRejectedValueOnce(apiError(404, 1));
    await act(() => result.current.store.deleteItem('later0000001'));
    old.resolve(onServer);
    await settle();
    expect(shownTexts(result.current.board)).toEqual(['Follow up']);
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(result.current.generation).toBe(1);
    // And the 404 reads nothing again.
    expect(api.getBoard).toHaveBeenCalledTimes(2);
  });

  it('puts the task back and rejects when the server refuses the delete, and reads the board again', async () => {
    const { result } = renderBoard();
    await settle();
    vi.mocked(api.deleteItem).mockRejectedValueOnce(apiError(500));
    await expect(act(() => result.current.store.deleteItem('later0000001'))).rejects.toThrow('Request failed (500)');
    expect(shownTexts(result.current.board)).toEqual(['Write a KB', 'Follow up']);
    expect(api.getBoard).toHaveBeenCalledTimes(2);
    expect(result.current.generation).toBe(0);
  });

  it('reads again a left-open offer already fetched, which no longer offers the task, and a held past day that listed it', async () => {
    serveRange([makeDay(YESTERDAY, { priorities: [makePriority(1, 'Write a KB', { uid: 'later0000001' })] })]);
    const { result } = renderHook(
      () => {
        useDay(TODAY);
        return { store: useBoardStore(), offer: useLeftOpen(TODAY, true).leftOpen };
      },
      { wrapper: SettingsAndDays },
    );
    await settle();
    expect(result.current.offer?.rows.map((p) => p.uid)).toEqual(['later0000001']);
    serveRange([makeDay(YESTERDAY)]);
    await act(() => result.current.store.deleteItem('later0000001'));
    await settle();
    expect(api.getRange).toHaveBeenCalledTimes(2);
    expect(result.current.offer).toBeNull();
  });
});

describe('removeFromToday', () => {
  it("takes a recurring row off today's list and deletes nothing", async () => {
    lists[TODAY] = [makePriority(1, 'Monitor the queue', { uid: 'rcur00000001', recurring: true })];
    const { result } = renderBoard();
    await settle();
    await act(() => result.current.store.removeFromToday('rcur00000001'));
    expect(putCalls()).toEqual([{ date: TODAY, texts: ['', '', ''] }]);
    expect(api.deleteItem).not.toHaveBeenCalled();
  });
});

describe('categories', () => {
  const TICKETS = makeCategory('cat000000001', 'Tickets');
  const names = (b: Board | undefined) => b?.categories.map((c) => `${c.name}${c.archived ? ' (removed)' : ''}`);

  beforeEach(() => {
    onServer = { ...onServer, categories: [TICKETS] };
  });

  it('show a new, renamed or removed category at once, and go out one after another', async () => {
    const first = deferredAnswer<Board>();
    vi.mocked(api.addCategory).mockReturnValueOnce(first.promise);
    const { result } = renderBoard();
    await settle();
    act(() => {
      void result.current.store.addCategory({ uid: 'cat000000002', name: 'KB', color: 'teal' });
      void result.current.store.editCategory('cat000000001', { name: 'Tix', color: 'pink' });
      void result.current.store.removeCategory('cat000000001');
    });
    expect(names(result.current.board)).toEqual(['Tix (removed)', 'KB']);
    expect(api.patchCategory).not.toHaveBeenCalled();
    first.resolve((onServer = withCategory(onServer, { uid: 'cat000000002', name: 'KB', color: 'teal' })));
    await settle();
    expect(api.patchCategory).toHaveBeenCalledExactlyOnceWith('cat000000001', { name: 'Tix', color: 'pink' });
    expect(api.deleteCategory).toHaveBeenCalledExactlyOnceWith('cat000000001');
    expect(result.current.board).toEqual(onServer);
    expect(result.current.board?.categories[0]).toMatchObject({ color: 'pink', archived: true });
  });

  it('take a failed category write off, reject, and read the board again', async () => {
    const { result } = renderBoard();
    await settle();
    vi.mocked(api.patchCategory).mockRejectedValueOnce(new Error('offline'));
    await expect(act(() => result.current.store.editCategory('cat000000001', { name: 'Tix' }))).rejects.toThrow('offline');
    expect(names(result.current.board)).toEqual(['Tickets']);
    expect(api.getBoard).toHaveBeenCalledTimes(2);
  });

  it('read the board again after a refused write, beside a read already out, so a name another device took shows', async () => {
    const { result } = renderBoard();
    await settle();
    // The minute's read is out when the create is refused: another device took the name.
    const minute = deferredAnswer<Board>();
    const theirs = withCategory(onServer, { uid: 'cat000000009', name: 'KB', color: 'teal' });
    vi.mocked(api.getBoard).mockReturnValueOnce(minute.promise).mockResolvedValueOnce(answered(theirs, 2));
    await settle(MINUTE_MS);
    vi.mocked(api.addCategory).mockRejectedValueOnce(apiError(400, 2));
    await expect(act(() => result.current.store.addCategory({ uid: 'cat000000002', name: 'KB', color: 'teal' }))).rejects.toThrow('Request failed (400)');
    expect(api.getBoard).toHaveBeenCalledTimes(3);
    await settle();
    expect(names(result.current.board)).toEqual(['Tickets', 'KB']);
    // The read out from before answers lower, and is dropped.
    minute.resolve(onServer, 1);
    await settle();
    expect(names(result.current.board)).toEqual(['Tickets', 'KB']);
  });

  describe('useCategoryPick', () => {
    function renderPick(report?: (saved: Promise<void>) => void) {
      return renderHook(() => ({ pick: useCategoryPick(report), board: useBoardState().board }), { wrapper: SettingsAndDays });
    }

    it("is null until the board's first read lands", async () => {
      const read = deferredAnswer<Board>();
      vi.mocked(api.getBoard).mockReturnValueOnce(read.promise);
      const { result } = renderPick();
      await settle();
      expect(result.current.pick).toBeNull();
      read.resolve(onServer);
      await settle();
      expect(result.current.pick?.categories).toEqual([TICKETS]);
    });

    it('makes a new category at once and gives its uid, and gives a category in use by its name without sending', async () => {
      const { result } = renderPick();
      await settle();
      let uid: string | null = null;
      act(() => {
        uid = result.current.pick!.create('  Knowledge   base ');
      });
      expect(uid).toMatch(/^[0-9a-f]{12}$/);
      expect(result.current.pick?.categories).toEqual([TICKETS, makeCategory(uid!, 'Knowledge base', { color: 'teal' })]);
      await settle();
      expect(api.addCategory).toHaveBeenCalledExactlyOnceWith({ uid, name: 'Knowledge base', color: 'teal' });

      expect(result.current.pick!.create('TICKETS')).toBe('cat000000001');
      expect(result.current.pick!.create(' ')).toBeNull();
      await settle();
      expect(api.addCategory).toHaveBeenCalledTimes(1);
    });

    it('brings a removed category back under its own uid', async () => {
      onServer = { ...onServer, categories: [TICKETS, makeCategory('cat000000002', 'Admin', { color: 'gold', archived: true })] };
      const { result } = renderPick();
      await settle();
      let uid: string | null = null;
      act(() => {
        uid = result.current.pick!.create('admin');
      });
      expect(uid).toBe('cat000000002');
      await settle();
      expect(api.addCategory).toHaveBeenCalledWith({ uid: 'cat000000002', name: 'admin', color: 'gold' });
      expect(result.current.pick?.categories[1]).toEqual(makeCategory('cat000000002', 'admin', { color: 'gold' }));
    });

    it('hands a failed create to report, with the category taken off and the board read again', async () => {
      const report = vi.fn<(saved: Promise<void>) => void>();
      const { result } = renderPick(report);
      await settle();
      vi.mocked(api.addCategory).mockRejectedValueOnce(new Error('offline'));
      act(() => void result.current.pick!.create('KB'));
      await expect(report.mock.calls[0]![0]).rejects.toThrow('offline');
      await settle();
      expect(result.current.pick?.categories).toEqual([TICKETS]);
      expect(api.getBoard).toHaveBeenCalledTimes(2);
    });

    it('raises the not-saved banner for a failed create by default', async () => {
      const { result } = renderPick();
      await settle();
      vi.mocked(api.addCategory).mockRejectedValueOnce(new Error('offline'));
      act(() => void result.current.pick!.create('KB'));
      await settle();
      expect(warnSaveFailed).toHaveBeenCalledOnce();
    });

    it('reads the board again on refresh', async () => {
      const { result } = renderPick();
      await settle();
      act(() => result.current.pick!.refresh());
      await settle();
      expect(api.getBoard).toHaveBeenCalledTimes(2);
    });
  });
});

it('useBoardState and useBoardStore refuse to run outside the provider', () => {
  expect(() => renderHook(() => useBoardState())).toThrow('useBoardState outside BoardProvider');
  expect(() => renderHook(() => useBoardStore())).toThrow('useBoardStore outside BoardProvider');
});

describe('recurring priorities', () => {
  const QUEUE = makeRecurring('rcur00000001', 'Monitor the queue');
  const titles = (b: Board | undefined) => b?.recurring.map((r) => `${r.title} ${r.weekdays.join('')}`);

  beforeEach(() => {
    onServer = { ...onServer, recurring: [QUEUE] };
  });

  it('show a new, edited or removed item at once, and go out one after another', async () => {
    const first = deferredAnswer<Board>();
    vi.mocked(api.addItem).mockReturnValueOnce(first.promise);
    const { result } = renderBoard();
    await settle();
    const timesheet = makeRecurring('rcur00000002', 'Timesheet', { weekdays: [5] });
    act(() => {
      void result.current.store.addItem(timesheet);
      void result.current.store.editItem('rcur00000002', { title: 'Timesheets', weekday: { day: 1, on: true } });
      void result.current.store.removeRecurring('rcur00000001');
    });
    expect(titles(result.current.board)).toEqual(['Timesheets 15']);
    expect(api.editItem).not.toHaveBeenCalled();
    expect(api.deleteItem).not.toHaveBeenCalled();
    first.resolve((onServer = withItem(onServer, timesheet, T0)));
    await settle();
    expect(api.addItem).toHaveBeenCalledExactlyOnceWith(timesheet);
    expect(api.editItem).toHaveBeenCalledExactlyOnceWith('rcur00000002', { title: 'Timesheets', weekday: { day: 1, on: true } });
    expect(api.deleteItem).toHaveBeenCalledExactlyOnceWith('rcur00000001');
    expect(callOrder(api.editItem)).toBeLessThan(callOrder(api.deleteItem));
    expect(result.current.board).toEqual(onServer);
    expect(titles(result.current.board)).toEqual(['Timesheets 15']);
  });

  it("removes one without touching today's list, which keeps its row", async () => {
    lists[TODAY] = [makePriority(1, 'Monitor the queue', { uid: QUEUE.uid, recurring: true })];
    const { result } = renderBoard();
    await settle();
    await act(() => result.current.store.removeRecurring(QUEUE.uid));
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(result.current.generation).toBe(0);
  });

  it('take a failed write off, reject, and read the board again', async () => {
    const { result } = renderBoard();
    await settle();
    vi.mocked(api.editItem).mockRejectedValueOnce(new Error('offline'));
    await expect(act(() => result.current.store.editItem('rcur00000001', { title: 'Queue' }))).rejects.toThrow('offline');
    expect(titles(result.current.board)).toEqual(['Monitor the queue 12345']);
    expect(api.getBoard).toHaveBeenCalledTimes(2);

    vi.mocked(api.addItem).mockRejectedValueOnce(apiError(400));
    await expect(act(() => result.current.store.addItem(makeRecurring('rcur00000002', 'Timesheet')))).rejects.toThrow('Request failed (400)');
    expect(titles(result.current.board)).toEqual(['Monitor the queue 12345']);

    vi.mocked(api.deleteItem).mockRejectedValueOnce(apiError(500));
    await expect(act(() => result.current.store.removeRecurring('rcur00000001'))).rejects.toThrow('Request failed (500)');
    expect(titles(result.current.board)).toEqual(['Monitor the queue 12345']);
    expect(api.getBoard).toHaveBeenCalledTimes(4);
  });

  it('count a 404 on a remove as done: another device removed it already', async () => {
    const { result } = renderBoard();
    await settle();
    // A read that still has it, sent before the remove was answered, doesn't bring it back.
    const old = deferredAnswer<Board>();
    vi.mocked(api.getBoard).mockReturnValueOnce(old.promise);
    act(() => void result.current.store.load());
    vi.mocked(api.deleteItem).mockRejectedValueOnce(apiError(404, 1));
    await act(() => result.current.store.removeRecurring('rcur00000001'));
    old.resolve(onServer);
    await settle();
    expect(titles(result.current.board)).toEqual([]);
    // And the 404 reads nothing again.
    expect(api.getBoard).toHaveBeenCalledTimes(2);
  });
});
