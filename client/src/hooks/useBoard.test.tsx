// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { DAY_MS, MINUTE_MS } from '../../../shared/dates.js';
import { MAX_PRIORITIES } from '../../../shared/settings.js';
import { warnQuietly } from '../lib/alerts';
import { MoveRefused, withCard, withCategory, withCategoryPatch, withoutCard, withoutCategory, withPatch, type StoreMove } from '../lib/board';
import { ADD_PRIORITY_FAILED, BOARD, SAVE_FAILED } from '../lib/copy';
import {
  apiError,
  begin,
  deferred,
  makeBoard,
  makeCard,
  makeCategory,
  makeDay,
  makePriority,
  makeSettings,
  settle,
  SettingsAndDays,
  setVisibility,
  T0,
  TODAY,
} from '../test/hooks';
import type { Board, Day, Priority } from '../types';
import { useBoardState, useBoardStore, useCategoryPick } from './useBoard';
import { useDay, useDayStore } from './useDay';
import { useSettings } from './useSettings';

vi.mock('../api');
vi.mock('../lib/alerts');

const TOMORROW = '2026-09-29';

/** The board, its store, the day store and the settings' update, with today loaded as the board view loads it. */
function renderBoard({ strict = false, today = true } = {}) {
  return renderHook(
    () => {
      if (today) useDay(TODAY);
      return { ...useBoardState(), store: useBoardStore(), days: useDayStore(), updateSettings: useSettings().update };
    },
    { wrapper: SettingsAndDays, reactStrictMode: strict },
  );
}

/** The server's board, which each board route below changes as the real one does. */
let onServer: Board;
/** Each day's list on the server, stored as each PUT sends it. */
let lists: Record<string, Priority[]>;

const putCalls = () =>
  vi.mocked(api.putPriorities).mock.calls.map(([date, list, put]) => ({ date, texts: list.map((p) => p.text), cards: put.cards, touched: put.touched }));
const LANE_ORDER = { later: 0, next: 1, done: 2 };
/** The board's cards' titles in the order the server sends them: Later, Next, then Done, each by position. */
const shownTexts = (b: Board | undefined) =>
  b && [...b.cards].sort((x, y) => LANE_ORDER[x.lane] - LANE_ORDER[y.lane] || x.position - y.position).map((c) => c.title);

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  onServer = makeBoard(makeCard('later0000001', 'Write a KB'), makeCard('next00000001', 'Follow up', { lane: 'next' }));
  lists = {};
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings({ board: true }));
  vi.mocked(api.putSettings).mockImplementation((patch) => Promise.resolve(makeSettings(patch as Parameters<typeof makeSettings>[0])));
  vi.mocked(api.getDay).mockImplementation((date) => Promise.resolve(makeDay(date, { priorities: lists[date] ?? [] })));
  vi.mocked(api.putPriorities).mockImplementation((date, list) => Promise.resolve({ priorities: (lists[date] = list) }));
  vi.mocked(api.getBoard).mockImplementation(() => Promise.resolve(onServer));
  vi.mocked(api.addCard).mockImplementation((card) => Promise.resolve((onServer = withCard(onServer, card, T0))));
  vi.mocked(api.patchCard).mockImplementation((uid, { today: _today, ...patch }) => Promise.resolve((onServer = withPatch(onServer, uid, patch))));
  vi.mocked(api.deleteCard).mockImplementation((uid) => Promise.resolve((onServer = withoutCard(onServer, uid))));
  vi.mocked(api.addCategory).mockImplementation((c) => Promise.resolve((onServer = withCategory(onServer, c))));
  vi.mocked(api.patchCategory).mockImplementation((uid, patch) => Promise.resolve((onServer = withCategoryPatch(onServer, uid, patch))));
  vi.mocked(api.deleteCategory).mockImplementation((uid) => Promise.resolve((onServer = withoutCategory(onServer, uid))));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('reading the board', () => {
  it('sends nothing while the board is off or the settings have not loaded, and nothing ticks', async () => {
    const settings = deferred<ReturnType<typeof makeSettings>>();
    vi.mocked(api.getSettings).mockResolvedValue(makeSettings()).mockReturnValueOnce(settings.promise);
    lists[TODAY] = [makePriority(1, 'Typed with the board off')];
    const { result } = renderBoard();
    await settle();
    expect(result.current.on).toBe(false);
    settings.resolve(makeSettings());
    await settle(5 * MINUTE_MS);
    await act(() => result.current.store.load());
    expect(result.current.on).toBe(false);
    expect(api.getBoard).not.toHaveBeenCalled();
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(result.current.board).toBeUndefined();
  });

  it('reads at once when switched on, once under StrictMode, and keeps the board when switched off', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(makeSettings());
    const { result } = renderBoard({ strict: true });
    await settle();
    expect(api.getBoard).not.toHaveBeenCalled();
    await act(() => result.current.updateSettings({ board: true }));
    await settle();
    expect(api.getBoard).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({ on: true, failed: false });
    expect(shownTexts(result.current.board)).toEqual(['Write a KB', 'Follow up']);

    await act(() => result.current.updateSettings({ board: false }));
    await settle(5 * MINUTE_MS);
    expect(api.getBoard).toHaveBeenCalledTimes(1);
    expect(shownTexts(result.current.board)).toEqual(['Write a KB', 'Follow up']);
  });

  it('reads every minute and when the tab comes back, and a load shares a read already out', async () => {
    const { result } = renderBoard();
    await settle();
    expect(api.getBoard).toHaveBeenCalledTimes(1);
    await settle(MINUTE_MS);
    expect(api.getBoard).toHaveBeenCalledTimes(2);
    await settle(10_000);
    act(() => setVisibility('hidden'));
    act(() => setVisibility('visible'));
    expect(api.getBoard).toHaveBeenCalledTimes(3);
    await settle();

    const answer = deferred<Board>();
    vi.mocked(api.getBoard).mockReturnValueOnce(answer.promise);
    let a!: Promise<void>, b!: Promise<void>;
    act(() => {
      a = result.current.store.load();
      b = result.current.store.load();
    });
    expect(a).toBe(b);
    answer.resolve(onServer);
    await act(() => a);
    expect(api.getBoard).toHaveBeenCalledTimes(4);
  });

  it('sends a fresh load after the read out, or at once when none is', async () => {
    const { result } = renderBoard();
    await settle();
    await act(() => result.current.store.load({ fresh: true }));
    expect(api.getBoard).toHaveBeenCalledTimes(2);
    const out = deferred<Board>();
    vi.mocked(api.getBoard).mockReturnValueOnce(out.promise);
    let fresh!: Promise<void>;
    act(() => {
      void result.current.store.load();
      fresh = result.current.store.load({ fresh: true });
    });
    expect(api.getBoard).toHaveBeenCalledTimes(3);
    out.resolve(onServer);
    await act(() => fresh);
    expect(api.getBoard).toHaveBeenCalledTimes(4);
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

    const old = deferred<Board>();
    vi.mocked(api.getBoard).mockReturnValueOnce(old.promise);
    act(() => void result.current.store.load());
    const stale = onServer;
    await act(() => result.current.store.addCard({ uid: 'new000000001', title: 'Captured', categoryUid: null, lane: 'later', before: null }));
    old.resolve(stale);
    await settle();
    expect(shownTexts(result.current.board)).toEqual(['Write a KB', 'Captured', 'Follow up']);
  });
});

describe('the sweep', () => {
  it("asks for cards for today's rows typed before the board was on, once, after the first read finds today held", async () => {
    lists[TODAY] = [makePriority(1, 'Typed with the board off'), makePriority(2, 'Already carded', { cardUid: 'next00000001' })];
    renderBoard();
    await settle();
    expect(putCalls()).toEqual([{ date: TODAY, texts: ['Typed with the board off', 'Already carded', ''], cards: true, touched: undefined }]);
    // Once a day: the next read sends nothing, though the echo left the row without a card.
    await settle(MINUTE_MS);
    expect(api.getBoard).toHaveBeenCalledTimes(2);
    expect(api.putPriorities).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when every row has a card or is a recurring priority, and looks again on a new day', async () => {
    lists[TODAY] = [makePriority(1, 'Carded', { cardUid: 'next00000001' }), makePriority(2, 'Monitor the queue', { recurringUid: 'rec000000001' })];
    const { result } = renderBoard();
    await settle();
    expect(api.putPriorities).not.toHaveBeenCalled();
    // A new day, held, with a row from before the board: swept after the next read.
    vi.setSystemTime(T0 + DAY_MS);
    lists[TOMORROW] = [makePriority(1, 'Planned while off')];
    await act(() => result.current.days.load(TOMORROW));
    await settle(MINUTE_MS);
    expect(putCalls()).toEqual([{ date: TOMORROW, texts: ['Planned while off', '', ''], cards: true, touched: undefined }]);
  });

  it('sends nothing when the rows have their cards by the time its turn on the board queue comes', async () => {
    lists[TODAY] = [makePriority(1, 'Typed with the board off')];
    const capture = deferred<Board>();
    vi.mocked(api.addCard).mockReturnValueOnce(capture.promise);
    const read = deferred<Board>();
    vi.mocked(api.getBoard).mockReturnValueOnce(read.promise);
    const { result } = renderBoard();
    await settle();
    // A capture is out on the board queue when the read lands, so the sweep waits behind it.
    act(() => void result.current.store.addCard({ uid: 'cap000000001', title: 'Captured', categoryUid: null, lane: 'later', before: null }));
    read.resolve(onServer);
    await settle();
    // Meanwhile the sheet saved the row, and the server gave it its card.
    const shown = result.current.days.shown(TODAY)!.priorities;
    vi.mocked(api.putPriorities).mockImplementationOnce((date, list) =>
      Promise.resolve({ priorities: (lists[date] = list.map((p) => ({ ...p, cardUid: 'card00000001' }))) }),
    );
    await act(() => result.current.days.setPriorities(TODAY, shown, shown));
    capture.resolve(onServer);
    await settle();
    expect(api.putPriorities).toHaveBeenCalledTimes(1);
  });

  it('waits for today to be held, and tries again after a read when its save failed', async () => {
    const day = deferred<Day>();
    vi.mocked(api.getDay).mockReturnValueOnce(day.promise);
    renderBoard();
    await settle();
    expect(api.getBoard).toHaveBeenCalledTimes(1);
    lists[TODAY] = [makePriority(1, 'From before')];
    day.resolve(makeDay(TODAY, { priorities: lists[TODAY] }));
    await settle();
    expect(api.putPriorities).not.toHaveBeenCalled();

    vi.mocked(api.putPriorities).mockRejectedValueOnce(new Error('offline'));
    await settle(MINUTE_MS);
    expect(api.putPriorities).toHaveBeenCalledTimes(1);
    await settle(MINUTE_MS);
    expect(putCalls().map((c) => c.cards)).toEqual([true, true]);
  });
});

describe('card writes', () => {
  it('show at once and go out one after another', async () => {
    const first = deferred<Board>();
    vi.mocked(api.addCard).mockReturnValueOnce(first.promise);
    const { result } = renderBoard();
    await settle();
    act(() => {
      void result.current.store.addCard({ uid: 'one000000001', title: 'One', categoryUid: null, lane: 'later', before: 'later0000001' });
      void result.current.store.editCard('next00000001', { lane: 'later', before: null });
    });
    expect(shownTexts(result.current.board)).toEqual(['One', 'Write a KB', 'Follow up']);
    expect(result.current.board?.cards.find((c) => c.uid === 'next00000001')?.lane).toBe('later');
    expect(api.patchCard).not.toHaveBeenCalled();
    first.resolve((onServer = withCard(onServer, { uid: 'one000000001', title: 'One', categoryUid: null, lane: 'later', before: 'later0000001' }, T0)));
    await settle();
    expect(api.patchCard).toHaveBeenCalledExactlyOnceWith('next00000001', { today: TODAY, lane: 'later', before: null });
    expect(result.current.board).toEqual(onServer);
  });

  it('take a failed change off, reject, and read the board again', async () => {
    const { result } = renderBoard();
    await settle();
    vi.mocked(api.addCard).mockRejectedValueOnce(new Error('offline'));
    await expect(
      act(() => result.current.store.addCard({ uid: 'lost00000001', title: 'Lost', categoryUid: null, lane: 'next', before: null })),
    ).rejects.toThrow('offline');
    expect(shownTexts(result.current.board)).toEqual(['Write a KB', 'Follow up']);
    expect(api.getBoard).toHaveBeenCalledTimes(2);
  });

  it('read today and the board again on a 409, and reject with the stale line', async () => {
    const { result } = renderBoard();
    await settle();
    vi.mocked(api.patchCard).mockRejectedValueOnce(apiError(409));
    const err = await act(() => result.current.store.editCard('later0000001', { title: 'Renamed' }).catch((e: unknown) => e));
    expect(err).toBeInstanceOf(MoveRefused);
    expect((err as Error).message).toBe(BOARD.stale);
    expect(api.getDay).toHaveBeenCalledTimes(2);
    expect(api.getBoard).toHaveBeenCalledTimes(2);
    expect(shownTexts(result.current.board)).toEqual(['Write a KB', 'Follow up']);
  });

  it("read the board again after a read still out on a 409, which may predate the other device's change", async () => {
    const { result } = renderBoard();
    await settle();
    const old = deferred<Board>();
    vi.mocked(api.getBoard).mockReturnValueOnce(old.promise);
    act(() => void result.current.store.load());
    vi.mocked(api.patchCard).mockRejectedValueOnce(apiError(409));
    const refused = begin(() => result.current.store.editCard('later0000001', { title: 'Renamed' }).catch((e: unknown) => e));
    await settle();
    expect(api.getBoard).toHaveBeenCalledTimes(2);
    old.resolve(onServer);
    expect(await act(() => refused)).toBeInstanceOf(MoveRefused);
    expect(api.getBoard).toHaveBeenCalledTimes(3);
  });
});

describe('moves', () => {
  const carded = (position: number, text: string, cardUid: string, patch: Partial<Priority> = {}) => makePriority(position, text, { cardUid, ...patch });
  const move = (result: ReturnType<typeof renderBoard>['result'], m: StoreMove) => act(() => result.current.store.move(m));

  it("pull a card onto today's list inside the job, touched, and the next board write waits for that save", async () => {
    lists[TODAY] = [carded(1, 'Report', 'card00000001')];
    const { result } = renderBoard();
    await settle();
    const save = deferred<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(save.promise);
    const row = { uid: 'pulled000001', addedAt: null, text: 'Write a KB', done: false, cardUid: 'later0000001', recurringUid: null, categoryUid: null };
    act(() => {
      void result.current.store.move({ kind: 'place', row, nudge: true });
      void result.current.store.addCard({ uid: 'after0000001', title: 'After', categoryUid: null, lane: 'next', before: null });
    });
    await settle();
    expect(putCalls()).toEqual([{ date: TODAY, texts: ['Report', 'Write a KB', ''], cards: true, touched: ['later0000001'] }]);
    // Stamped as it goes out: a row new to today's list.
    expect(vi.mocked(api.putPriorities).mock.calls[0]![1][1]).toMatchObject({ uid: 'pulled000001', addedAt: T0 });
    expect(api.addCard).not.toHaveBeenCalled();
    save.resolve({ priorities: vi.mocked(api.putPriorities).mock.calls[0]![1] });
    await settle();
    expect(api.addCard).toHaveBeenCalledTimes(1);
  });

  it('put a card in Done as a ticked row of today', async () => {
    const { result } = renderBoard();
    await settle();
    const row = { uid: 'ticked000001', addedAt: T0, text: 'Follow up', done: true, cardUid: 'next00000001', recurringUid: null, categoryUid: null };
    await move(result, { kind: 'place', row, nudge: false });
    expect(lists[TODAY]![0]).toMatchObject({ text: 'Follow up', done: true, cardUid: 'next00000001' });
    expect(putCalls()[0]!.touched).toEqual(['next00000001']);
  });

  it('refuse a pull onto a full list or one not loaded, and say when the save failed', async () => {
    lists[TODAY] = Array.from({ length: MAX_PRIORITIES }, (_, i) => makePriority(i + 1, `Row ${i + 1}`, { cardUid: `card${i}`.padEnd(12, '0') }));
    const { result } = renderBoard();
    await settle();
    const place = (cardUid: string): StoreMove => ({
      kind: 'place',
      row: { uid: 'x00000000001', addedAt: T0, text: 'X', done: false, cardUid, recurringUid: null, categoryUid: null },
      nudge: true,
    });
    await expect(move(result, place('later0000001'))).rejects.toThrow(new MoveRefused(ADD_PRIORITY_FAILED.full));
    lists[TODAY] = [];
    await act(() => result.current.days.load(TODAY));
    vi.mocked(api.putPriorities).mockRejectedValueOnce(new Error('offline'));
    await expect(move(result, place('later0000001'))).rejects.toThrow(SAVE_FAILED.title);
    expect(warnQuietly).toHaveBeenCalledWith(expect.objectContaining({ title: SAVE_FAILED.title }));

    const { result: noDay } = renderBoard({ today: false });
    await settle();
    const err = await act(() => noDay.current.store.move(place('next00000001')).catch((e: unknown) => e));
    expect(err).toEqual(new MoveRefused(ADD_PRIORITY_FAILED.notLoaded));
    expect(err).toBeInstanceOf(MoveRefused);
  });

  it("refuse a tick or a rename while today's list is not loaded", async () => {
    const { result } = renderBoard({ today: false });
    await settle();
    await expect(move(result, { kind: 'tick', rowUid: 'row000000001', done: true, cardUid: null })).rejects.toThrow(
      new MoveRefused(ADD_PRIORITY_FAILED.notLoaded),
    );
    await expect(act(() => result.current.store.editRow('row000000001', { text: 'New' }, null))).rejects.toThrow(
      new MoveRefused(ADD_PRIORITY_FAILED.notLoaded),
    );
  });

  it("tick and untick a row of today's list with its card as touched, and leave a row gone meanwhile alone", async () => {
    lists[TODAY] = [carded(1, 'Report', 'card00000001')];
    const { result } = renderBoard();
    await settle();
    const uid = lists[TODAY]![0]!.uid!;
    await move(result, { kind: 'tick', rowUid: uid, done: true, cardUid: 'card00000001' });
    expect(lists[TODAY]![0]!.done).toBe(true);
    await move(result, { kind: 'tick', rowUid: uid, done: false, cardUid: 'card00000001' });
    expect(lists[TODAY]![0]!.done).toBe(false);
    expect(putCalls().map((c) => c.touched)).toEqual([['card00000001'], ['card00000001']]);
    await move(result, { kind: 'tick', rowUid: 'gone00000001', done: true, cardUid: null });
    expect(api.putPriorities).toHaveBeenCalledTimes(2);
  });

  it('rename a row of today, or give it a category, with its card as touched', async () => {
    lists[TODAY] = [carded(1, 'Report', 'card00000001')];
    const { result } = renderBoard();
    await settle();
    const uid = lists[TODAY]![0]!.uid!;
    await act(() => result.current.store.editRow(uid, { text: 'Report v2' }, 'card00000001'));
    expect(putCalls()).toEqual([{ date: TODAY, texts: ['Report v2', '', ''], cards: true, touched: ['card00000001'] }]);
    await act(() => result.current.store.editRow(uid, { categoryUid: 'cafe00000001' }, 'card00000001'));
    expect(lists[TODAY]![0]).toMatchObject({ text: 'Report v2', categoryUid: 'cafe00000001' });
    expect(putCalls()[1]!.touched).toEqual(['card00000001']);
  });

  it('change a card through a patch move as an edit, sent with today', async () => {
    const { result } = renderBoard();
    await settle();
    await move(result, { kind: 'patch', uid: 'later0000001', patch: { lane: 'next', before: null } });
    expect(api.patchCard).toHaveBeenCalledWith('later0000001', { today: TODAY, lane: 'next', before: null });
    expect(result.current.board?.cards.find((c) => c.uid === 'later0000001')?.lane).toBe('next');
  });

  describe('park', () => {
    it("places the row's card first, then takes the row off today's list, touched", async () => {
      lists[TODAY] = [carded(1, 'Report', 'card00000001'), carded(2, 'Email', 'card00000002')];
      onServer = makeBoard(...onServer.cards, makeCard('card00000001', 'Report', { lane: 'next', position: 2, listDate: TODAY }));
      const { result } = renderBoard();
      await settle();
      const placed = deferred<Board>();
      vi.mocked(api.addCard).mockReturnValueOnce(placed.promise);
      const parked = begin(() => result.current.store.move({ kind: 'park', row: lists[TODAY]![0]!, lane: 'later', before: 'later0000001' }));
      await settle();
      // Shown in Later while the board places it; the row leaves today's list once that is done.
      expect(result.current.board?.cards.find((c) => c.uid === 'card00000001')).toMatchObject({ lane: 'later', position: 1 });
      expect(api.putPriorities).not.toHaveBeenCalled();
      placed.resolve((onServer = withCard(onServer, { uid: 'card00000001', title: 'Report', categoryUid: null, lane: 'later', before: 'later0000001' }, T0)));
      await act(() => parked);
      expect(api.addCard).toHaveBeenCalledExactlyOnceWith({ uid: 'card00000001', title: 'Report', categoryUid: null, lane: 'later', before: 'later0000001' });
      // The list as the card pads it, less the row: the card pads it again on screen.
      expect(putCalls()).toEqual([{ date: TODAY, texts: ['Email', ''], cards: true, touched: ['card00000001'] }]);
      expect(vi.mocked(api.addCard).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.putPriorities).mock.invocationCallOrder[0]!);
      expect(result.current.board?.cards.find((c) => c.uid === 'card00000001')).toMatchObject({ lane: 'later', position: 1 });
    });

    it('sends no removal when placing the card fails', async () => {
      lists[TODAY] = [carded(1, 'Report', 'card00000001')];
      const { result } = renderBoard();
      await settle();
      vi.mocked(api.addCard).mockRejectedValueOnce(new Error('offline'));
      await expect(move(result, { kind: 'park', row: lists[TODAY]![0]!, lane: 'next', before: null })).rejects.toThrow('offline');
      expect(api.putPriorities).not.toHaveBeenCalled();
      expect(lists[TODAY]!.map((p) => p.text)).toEqual(['Report']);
    });

    it('gives a row with no card one first, from a save asking for cards, and places that card', async () => {
      lists[TODAY] = [makePriority(1, 'Report', { cardUid: 'card00000009' }), makePriority(2, 'Email')];
      const { result } = renderBoard();
      await settle();
      // The sweep has gone; the server makes Email's card on the save that asks.
      vi.mocked(api.putPriorities).mockClear();
      vi.mocked(api.putPriorities).mockImplementationOnce((date, list) =>
        Promise.resolve({ priorities: (lists[date] = list.map((p) => (p.text === 'Email' ? { ...p, cardUid: 'minted000001' } : p))) }),
      );
      const email = result.current.days.shown(TODAY)!.priorities[1]!;
      await move(result, { kind: 'park', row: email, lane: 'next', before: null });
      expect(putCalls().map((c) => [c.texts, c.touched])).toEqual([
        [['Report', 'Email', ''], undefined],
        [['Report', ''], ['minted000001']],
      ]);
      expect(api.addCard).toHaveBeenCalledExactlyOnceWith({ uid: 'minted000001', title: 'Email', categoryUid: null, lane: 'next', before: null });
    });

    it("posts the row's title and category as the list shows them when the job runs, so a park keeps the card's category", async () => {
      lists[TODAY] = [carded(1, 'Report', 'card00000001', { categoryUid: 'cafe00000001' })];
      const { result } = renderBoard();
      await settle();
      const planned = result.current.days.shown(TODAY)!.priorities[0]!;
      // Renamed and recategorised while the park waits behind a capture on the board queue.
      const capture = deferred<Board>();
      vi.mocked(api.addCard).mockReturnValueOnce(capture.promise);
      act(() => void result.current.store.addCard({ uid: 'cap000000001', title: 'Captured', categoryUid: null, lane: 'later', before: null }));
      const parked = begin(() => result.current.store.move({ kind: 'park', row: planned, lane: 'next', before: null }));
      const renamed = { ...planned, text: 'Report v2', categoryUid: 'cafe00000002' };
      await act(() => result.current.days.setPriorities(TODAY, [renamed], [planned]));
      capture.resolve(onServer);
      await act(() => parked);
      expect(vi.mocked(api.addCard).mock.calls[1]![0]).toEqual({
        uid: 'card00000001',
        title: 'Report v2',
        categoryUid: 'cafe00000002',
        lane: 'next',
        before: null,
      });
    });

    it('keeps the planned title when the row was emptied meanwhile, and parks nothing for a cardless row gone from the list', async () => {
      lists[TODAY] = [carded(1, 'Report', 'card00000001'), makePriority(2, 'Email')];
      const { result } = renderBoard();
      await settle();
      vi.mocked(api.putPriorities).mockClear();
      const [report, email] = result.current.days.shown(TODAY)!.priorities as [Priority, Priority];
      await act(() => result.current.days.setPriorities(TODAY, [{ ...report, text: '' }, email], [report, email]));
      await move(result, { kind: 'park', row: report, lane: 'next', before: null });
      expect(api.addCard).toHaveBeenLastCalledWith({ uid: 'card00000001', title: 'Report', categoryUid: null, lane: 'next', before: null });

      // Email taken off on another device; the mint save brings that list back with no Email.
      vi.mocked(api.addCard).mockClear();
      vi.mocked(api.putPriorities).mockImplementationOnce((date) => Promise.resolve({ priorities: (lists[date] = []) }));
      await move(result, { kind: 'park', row: email, lane: 'later', before: null });
      expect(api.addCard).not.toHaveBeenCalled();
      expect(warnQuietly).not.toHaveBeenCalled();
    });

    it('refuses with the full line, posting nothing, when the save makes no card', async () => {
      lists[TODAY] = [makePriority(1, 'Report', { cardUid: 'card00000009' }), makePriority(2, 'Email', { recurringUid: 'rec000000001' })];
      const { result } = renderBoard();
      await settle();
      const row = { ...lists[TODAY]![1]!, recurringUid: null };
      await expect(move(result, { kind: 'park', row, lane: 'later', before: null })).rejects.toThrow(new MoveRefused(BOARD.full));
      expect(api.addCard).not.toHaveBeenCalled();
    });

    it('refuses a row whose list is not loaded or whose save fails, before placing anything', async () => {
      const { result: noDay } = renderBoard({ today: false });
      await settle();
      await expect(move(noDay, { kind: 'park', row: makePriority(1, 'Report'), lane: 'later', before: null })).rejects.toThrow(
        new MoveRefused(ADD_PRIORITY_FAILED.notLoaded),
      );
      cleanup();
      lists[TODAY] = [makePriority(1, 'Report', { cardUid: 'card00000009' }), makePriority(2, 'Email')];
      const { result } = renderBoard();
      await settle();
      vi.mocked(api.putPriorities).mockRejectedValueOnce(new Error('offline'));
      await expect(move(result, { kind: 'park', row: lists[TODAY]![1]!, lane: 'later', before: null })).rejects.toThrow(SAVE_FAILED.title);
      expect(api.addCard).not.toHaveBeenCalled();
    });

    it('places the same card again on a retry after a failed removal', async () => {
      lists[TODAY] = [makePriority(1, 'Report', { cardUid: 'card00000009' }), makePriority(2, 'Email')];
      const { result } = renderBoard();
      await settle();
      vi.mocked(api.putPriorities)
        .mockImplementationOnce((date, list) =>
          Promise.resolve({ priorities: (lists[date] = list.map((p) => (p.text === 'Email' ? { ...p, cardUid: 'minted000001' } : p))) }),
        )
        .mockRejectedValueOnce(new Error('offline'));
      const email = () => result.current.days.shown(TODAY)!.priorities.find((p) => p.text === 'Email')!;
      await expect(move(result, { kind: 'park', row: email(), lane: 'next', before: null })).rejects.toThrow(SAVE_FAILED.title);
      // The row stays on today's list, linked to the card it was given.
      expect(email().cardUid).toBe('minted000001');
      await move(result, { kind: 'park', row: email(), lane: 'next', before: null });
      expect(vi.mocked(api.addCard).mock.calls.map(([c]) => c.uid)).toEqual(['minted000001', 'minted000001']);
      expect(lists[TODAY]!.map((p) => p.text)).toEqual(['Report', '']);
    });
  });
});

describe('deleteCard', () => {
  it("takes today's row off, then loads the later day and takes its row off, then deletes the card, gone from the board at once", async () => {
    lists[TODAY] = [makePriority(1, 'Report', { cardUid: 'later0000001' }), makePriority(2, 'Email', { cardUid: 'card00000002' })];
    lists[TOMORROW] = [makePriority(1, 'Plan', { cardUid: 'other0000001' }), makePriority(2, 'Report', { cardUid: 'later0000001' })];
    const { result } = renderBoard();
    await settle();
    const remove = deferred<Board>();
    vi.mocked(api.deleteCard).mockReturnValueOnce(remove.promise);
    act(() => void result.current.store.deleteCard('later0000001', lists[TODAY]![0]!.uid, TOMORROW));
    expect(shownTexts(result.current.board)).toEqual(['Follow up']);
    await settle();
    expect(putCalls().map((c) => [c.date, c.texts])).toEqual([
      [TODAY, ['Email', '']],
      [TOMORROW, ['Plan', '']],
    ]);
    expect(api.getDay).toHaveBeenCalledWith(TOMORROW);
    expect(api.deleteCard).toHaveBeenCalledExactlyOnceWith('later0000001');
    remove.resolve((onServer = withoutCard(onServer, 'later0000001')));
    await settle();
    expect(shownTexts(result.current.board)).toEqual(['Follow up']);
  });

  it('counts a 404 as done: a save in the job, or another device, took the card already', async () => {
    const { result } = renderBoard();
    await settle();
    // A read that still has the card, sent before the delete was answered, doesn't bring it back.
    const old = deferred<Board>();
    vi.mocked(api.getBoard).mockReturnValueOnce(old.promise);
    act(() => void result.current.store.load());
    vi.mocked(api.deleteCard).mockRejectedValueOnce(apiError(404));
    await act(() => result.current.store.deleteCard('later0000001', null, null));
    old.resolve(onServer);
    await settle();
    expect(shownTexts(result.current.board)).toEqual(['Follow up']);
    expect(api.putPriorities).not.toHaveBeenCalled();
    // And the 404 reads nothing again.
    expect(api.getBoard).toHaveBeenCalledTimes(2);
  });

  it("takes a recurring row, which has no card, off today's list and deletes nothing", async () => {
    lists[TODAY] = [makePriority(1, 'Monitor the queue', { recurringUid: 'rec000000001' })];
    const { result } = renderBoard();
    await settle();
    await act(() => result.current.store.deleteCard(null, lists[TODAY]![0]!.uid, null));
    expect(putCalls().map((c) => c.texts)).toEqual([['', '']]);
    expect(api.deleteCard).not.toHaveBeenCalled();
  });

  it('brings the card back when the server refuses the delete', async () => {
    const { result } = renderBoard();
    await settle();
    vi.mocked(api.deleteCard).mockRejectedValueOnce(apiError(500));
    await expect(act(() => result.current.store.deleteCard('later0000001', null, null))).rejects.toThrow('Request failed (500)');
    expect(shownTexts(result.current.board)).toEqual(['Write a KB', 'Follow up']);
  });

  it('brings the card back when a step fails, and deletes nothing', async () => {
    lists[TODAY] = [makePriority(1, 'Report', { cardUid: 'later0000001' })];
    const { result } = renderBoard();
    await settle();
    vi.mocked(api.putPriorities).mockRejectedValueOnce(new Error('offline'));
    await expect(act(() => result.current.store.deleteCard('later0000001', lists[TODAY]![0]!.uid, null))).rejects.toThrow(SAVE_FAILED.title);
    expect(shownTexts(result.current.board)).toEqual(['Write a KB', 'Follow up']);
    expect(api.deleteCard).not.toHaveBeenCalled();

    // A later day that could not be loaded stops the job there too.
    vi.mocked(api.getDay).mockRejectedValueOnce(new Error('offline'));
    await expect(act(() => result.current.store.deleteCard('later0000001', null, TOMORROW))).rejects.toThrow(new MoveRefused(ADD_PRIORITY_FAILED.notLoaded));
    expect(api.deleteCard).not.toHaveBeenCalled();
  });

  it('skips a row already gone from a list', async () => {
    const { result } = renderBoard();
    await settle();
    await act(() => result.current.days.load(TOMORROW));
    await act(() => result.current.store.deleteCard('later0000001', 'gone00000001', TOMORROW));
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(api.deleteCard).toHaveBeenCalledTimes(1);
  });
});

describe('categories', () => {
  const TICKETS = makeCategory('cat000000001', 'Tickets');
  const names = (b: Board | undefined) => b?.categories.map((c) => `${c.name}${c.archived ? ' (removed)' : ''}`);

  beforeEach(() => {
    onServer = { ...onServer, categories: [TICKETS] };
  });

  it('show a new, renamed or removed category at once, and go out one after another', async () => {
    const first = deferred<Board>();
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

  describe('useCategoryPick', () => {
    function renderPick(report?: (saved: Promise<void>) => void) {
      return renderHook(() => ({ pick: useCategoryPick(report), board: useBoardState().board, updateSettings: useSettings().update }), {
        wrapper: SettingsAndDays,
      });
    }

    it('is null while the board is off, and until its first read lands', async () => {
      vi.mocked(api.getSettings).mockResolvedValue(makeSettings());
      const read = deferred<Board>();
      vi.mocked(api.getBoard).mockReturnValueOnce(read.promise);
      const { result } = renderPick();
      await settle();
      expect(result.current.pick).toBeNull();
      await act(() => result.current.updateSettings({ board: true }));
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
      expect(warnQuietly).toHaveBeenCalledWith(expect.objectContaining({ title: SAVE_FAILED.title }));
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
