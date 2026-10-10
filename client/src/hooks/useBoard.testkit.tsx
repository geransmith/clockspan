import { renderHook } from '@testing-library/react';
import { beforeEach, vi } from 'vitest';
import * as api from '../api';
import { withCategory, withCategoryPatch, withItem, withItemPatch, withoutCategory, withoutItem } from '../lib/board';
import { answered, makeBoard, makeCard, makeDay, SettingsAndDays, T0, TODAY } from '../test/hooks';
import type { Board, Priority } from '../types';
import { useBoardState, useBoardStore } from './useBoard';
import { useDay, useDays, useDayStore } from './useDay';

// What the useBoard.*.test.tsx files share. Each one mocks '../api' and '../lib/alerts' itself,
// since `vi.mock` applies only in the file that calls it.

/** The board, its store and the day store, with today loaded as the board view loads it. */
export function renderBoard({ strict = false, today = true } = {}) {
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

/**
 * Before each case: the clock at T0, then the server's board, which each board route below changes
 * as the real one does, and each day's list, stored as each PUT sends it. They are the test file's
 * own `let onServer` and `let lists`, which its cases set too, so the file hands over reading and
 * setting them.
 */
export function serveBoard(server: {
  board: () => Board;
  setBoard: (board: Board) => Board;
  lists: () => Record<string, Priority[]>;
  setLists: (lists: Record<string, Priority[]>) => void;
}) {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 });
    server.setBoard(makeBoard(makeCard('later0000001', 'Write a KB'), makeCard('next00000001', 'Follow up', { lane: 'next' })));
    server.setLists({});
    vi.mocked(api.getDay).mockImplementation((date) => Promise.resolve(answered(makeDay(date, { priorities: server.lists()[date] ?? [] }))));
    vi.mocked(api.putPriorities).mockImplementation((date, list) => Promise.resolve(answered({ priorities: (server.lists()[date] = list) })));
    vi.mocked(api.getBoard).mockImplementation(() => Promise.resolve(answered(server.board())));
    vi.mocked(api.addItem).mockImplementation((item) => Promise.resolve(answered(server.setBoard(withItem(server.board(), item, T0)))));
    vi.mocked(api.editItem).mockImplementation((uid, patch) => Promise.resolve(answered(server.setBoard(withItemPatch(server.board(), uid, patch)))));
    vi.mocked(api.deleteItem).mockImplementation((uid) => Promise.resolve(answered(server.setBoard(withoutItem(server.board(), uid)))));
    vi.mocked(api.addCategory).mockImplementation((c) => Promise.resolve(answered(server.setBoard(withCategory(server.board(), c)))));
    vi.mocked(api.patchCategory).mockImplementation((uid, patch) => Promise.resolve(answered(server.setBoard(withCategoryPatch(server.board(), uid, patch)))));
    vi.mocked(api.deleteCategory).mockImplementation((uid) => Promise.resolve(answered(server.setBoard(withoutCategory(server.board(), uid)))));
  });
}

export const putCalls = () => vi.mocked(api.putPriorities).mock.calls.map(([date, list]) => ({ date, texts: list.map((p) => p.text) }));
export const callOrder = (fn: (...args: never[]) => unknown, n = 0) => vi.mocked(fn).mock.invocationCallOrder[n]!;
