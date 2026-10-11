// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { BOARD_LIMITS } from '../../../shared/api.js';
import { MINUTE_MS } from '../../../shared/dates.js';
import { MoveRefused, withItem, withItemPatch } from '../lib/board';
import { BOARD } from '../lib/copy';
import {
  answered,
  apiError,
  begin,
  deferredAnswer,
  makeBoard,
  makeCard,
  makeDay,
  makePriority,
  makeSettings,
  QUEUE,
  serveRange,
  settle,
  SettingsAndDays,
  setVisibility,
  T0,
  TODAY,
  YESTERDAY,
} from '../test/hooks';
import type { Board, Priority } from '../types';
import { useBoardStore } from './useBoard';
import { useDay } from './useDay';
import { useLeftOpen } from './useLeftOpen';
import { callOrder, putCalls, renderBoard, serveBoard } from './useBoard.testkit';

vi.mock('../api');
vi.mock('../lib/alerts');

const TOMORROW = '2026-09-29';

let onServer: Board;
let lists: Record<string, Priority[]>;
serveBoard({ board: () => onServer, setBoard: (board) => (onServer = board), lists: () => lists, setLists: (fresh) => (lists = fresh) });

const LANE_ORDER = { later: 0, next: 1 };
/** The board's tasks' titles in Later then Next, each by position, then the rest in the order sent. */
const shownTexts = (b: Board | undefined) =>
  b && [...b.cards].sort((x, y) => (x.lane ? LANE_ORDER[x.lane] : 2) - (y.lane ? LANE_ORDER[y.lane] : 2) || x.position - y.position).map((c) => c.title);

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

  it('offers the recurring priorities the server has confirmed, never a task whose first day is still on its way', async () => {
    onServer = { ...onServer, recurring: [QUEUE] };
    const { result } = renderBoard();
    await settle();
    expect(result.current.confirmedRecurring).toEqual([QUEUE]);
    const made = deferredAnswer<Board>();
    vi.mocked(api.editItem).mockReturnValueOnce(made.promise);
    const friday = { weekday: { day: 5, on: true } };
    act(() => {
      void result.current.store.editItem('next00000001', friday);
      void result.current.store.editItem(QUEUE.uid, { title: 'Watch the queue' });
    });
    expect(result.current.board?.recurring.map((r) => r.title)).toEqual(['Watch the queue', 'Follow up']);
    // A rename on its way shows; a task the server doesn't hold as a recurring priority yet isn't offered.
    expect(result.current.confirmedRecurring?.map((r) => r.title)).toEqual(['Watch the queue']);
    await settle();
    made.resolve((onServer = withItemPatch(onServer, 'next00000001', friday)));
    await settle();
    expect(result.current.confirmedRecurring?.map((r) => r.title)).toEqual(['Watch the queue', 'Follow up']);
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

  it("read again every held day that names a task given a new name or category, or made a recurring priority, and the ranges on screen, and nothing after a lane or a recurring priority's day", async () => {
    onServer = { ...onServer, recurring: [QUEUE] };
    const row = makePriority(1, 'Monitor the queue', { uid: QUEUE.uid, recurring: true });
    lists[TODAY] = [row];
    lists[YESTERDAY] = [row];
    lists[TOMORROW] = [makePriority(1, 'Email', { uid: 'email0000001' })];
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
    await act(() => result.current.store.editItem(QUEUE.uid, { weekday: { day: 6, on: true } }));
    await act(() => result.current.store.editItem(QUEUE.uid, { weekday: { day: 3, on: false } }));
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
    await act(() => result.current.store.editItem(QUEUE.uid, { title: 'Watch the queue' }));
    await settle();
    expect(reads()).toEqual([YESTERDAY, TODAY]);
    expect(result.current.heldDays[YESTERDAY]?.priorities[0]?.text).toBe('Watch the queue');
    expect(result.current.heldDays[TODAY]?.priorities[0]?.text).toBe('Watch the queue');
    expect(result.current.generation).toBe(2);
    vi.mocked(api.getDay).mockClear();
    await act(() => result.current.store.editItem(QUEUE.uid, { categoryUid: null }));
    await settle();
    expect(reads()).toEqual([YESTERDAY, TODAY]);
    expect(result.current.generation).toBe(3);
    // Its first day makes the task a recurring priority on every day that lists it.
    vi.mocked(api.getDay).mockClear();
    await act(() => result.current.store.editItem('email0000001', { weekday: { day: 2, on: true } }));
    await settle();
    expect(reads()).toEqual([TOMORROW]);
    expect(result.current.generation).toBe(4);
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

describe('recurring priorities', () => {
  const titles = (b: Board | undefined) => b?.recurring.map((r) => `${r.title} ${r.weekdays.join('')}`);

  beforeEach(() => {
    onServer = { ...onServer, recurring: [QUEUE] };
  });

  it('show a task made one, a day set and a removal at once, and go out one after another', async () => {
    const first = deferredAnswer<Board>();
    vi.mocked(api.editItem).mockReturnValueOnce(first.promise);
    const { result } = renderBoard();
    await settle();
    const friday = { weekday: { day: 5, on: true } };
    const monday = { title: 'Follow-ups', weekday: { day: 1, on: true } };
    act(() => {
      void result.current.store.editItem('next00000001', friday);
      void result.current.store.editItem('next00000001', monday);
      void result.current.store.removeRecurring(QUEUE.uid);
    });
    expect(titles(result.current.board)).toEqual(['Follow-ups 15']);
    expect(shownTexts(result.current.board)).toEqual(['Write a KB']);
    await settle();
    expect(api.editItem).toHaveBeenCalledOnce();
    expect(api.deleteItem).not.toHaveBeenCalled();
    first.resolve((onServer = withItemPatch(onServer, 'next00000001', friday)));
    await settle();
    expect(api.editItem).toHaveBeenLastCalledWith('next00000001', monday);
    expect(api.deleteItem).toHaveBeenCalledExactlyOnceWith(QUEUE.uid);
    expect(callOrder(api.editItem, 1)).toBeLessThan(callOrder(api.deleteItem));
    expect(result.current.board).toEqual(onServer);
    expect(titles(result.current.board)).toEqual(['Follow-ups 15']);
  });

  it("make a task one once today's save still out has landed, so a row typed seconds ago has its task, and set a day of one at once", async () => {
    const { result } = renderBoard();
    await settle();
    const typed = makePriority(1, 'Water the plants', { uid: 'plnt00000001' });
    const save = deferredAnswer<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(save.promise);
    act(() => void result.current.days.setPriorities(TODAY, [typed], []));
    const made = begin(() => result.current.store.editItem(typed.uid!, { weekday: { day: 6, on: true } }));
    await settle();
    expect(api.editItem).not.toHaveBeenCalled();
    save.resolve({ priorities: (lists[TODAY] = [typed]) });
    await act(() => made);
    expect(api.editItem).toHaveBeenCalledExactlyOnceWith(typed.uid, { weekday: { day: 6, on: true } });

    const again = deferredAnswer<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(again.promise);
    act(() => void result.current.days.setPriorities(TODAY, [typed, makePriority(2, 'Email')], [typed]));
    await act(() => result.current.store.editItem(QUEUE.uid, { weekday: { day: 6, on: true } }));
    expect(api.editItem).toHaveBeenCalledTimes(2);
    again.resolve({ priorities: lists[TODAY] });
    await settle();
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
    await expect(act(() => result.current.store.editItem(QUEUE.uid, { title: 'Queue' }))).rejects.toThrow('offline');
    expect(titles(result.current.board)).toEqual(['Monitor the queue 12345']);
    expect(api.getBoard).toHaveBeenCalledTimes(2);

    // At the cap of recurring priorities: the card stays where it was.
    vi.mocked(api.editItem).mockRejectedValueOnce(apiError(400));
    await expect(act(() => result.current.store.editItem('next00000001', { weekday: { day: 2, on: true } }))).rejects.toThrow('Request failed (400)');
    expect(titles(result.current.board)).toEqual(['Monitor the queue 12345']);
    expect(shownTexts(result.current.board)).toEqual(['Write a KB', 'Follow up']);

    vi.mocked(api.deleteItem).mockRejectedValueOnce(apiError(500));
    await expect(act(() => result.current.store.removeRecurring(QUEUE.uid))).rejects.toThrow('Request failed (500)');
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
    await act(() => result.current.store.removeRecurring(QUEUE.uid));
    old.resolve(onServer);
    await settle();
    expect(titles(result.current.board)).toEqual([]);
    // And the 404 reads nothing again.
    expect(api.getBoard).toHaveBeenCalledTimes(2);
  });
});
