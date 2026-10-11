// @vitest-environment happy-dom
import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { BOARD_LIMITS } from '../../../shared/api.js';
import { MAX_PRIORITIES } from '../../../shared/settings.js';
import { warnSaveFailed } from '../lib/alerts';
import { MoveRefused, withItemPatch, type StoreMove } from '../lib/board';
import { ADD_PRIORITY_FAILED, BOARD, SAVE_FAILED } from '../lib/copy';
import { answered, apiError, begin, deferredAnswer, makeBoard, makeCard, makePriority, QUEUE, settle, T0, TODAY, YESTERDAY } from '../test/hooks';
import type { Board, Priority } from '../types';
import { callOrder, putCalls, renderBoard, serveBoard } from './useBoard.testkit';

vi.mock('../api');
vi.mock('../lib/alerts');

let onServer: Board;
let lists: Record<string, Priority[]>;
serveBoard({ board: () => onServer, setBoard: (board) => (onServer = board), lists: () => lists, setLists: (fresh) => (lists = fresh) });

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
    onServer = { ...onServer, recurring: [QUEUE] };
    lists[TODAY] = [makePriority(1, 'Monitor the queue', { uid: QUEUE.uid, recurring: true })];
    const { result } = renderBoard();
    await settle();
    const old = deferredAnswer<Board>();
    vi.mocked(api.getBoard).mockReturnValueOnce(old.promise);
    act(() => void result.current.store.load());
    vi.mocked(api.putPriorities).mockImplementationOnce((date, list) => Promise.resolve(answered({ priorities: (lists[date] = list) }, 1)));
    await act(() => result.current.store.editRow(QUEUE.uid, { text: 'Watch the queue' }));
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
