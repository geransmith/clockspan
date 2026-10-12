// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { MINUTE_MS } from '../../../shared/dates.js';
import { warnSaveFailed } from '../lib/alerts';
import { withCategory } from '../lib/board';
import { answered, apiError, deferredAnswer, makeCategory, settle, SettingsAndDays, TICKETS } from '../test/hooks';
import type { Board, Priority } from '../types';
import { useBoardState, useCategoryPick } from './useBoard';
import { renderBoard, serveBoard } from './useBoard.testkit';

vi.mock('../api');
vi.mock('../lib/alerts');

let onServer: Board;
let lists: Record<string, Priority[]>;
serveBoard({ board: () => onServer, setBoard: (board) => (onServer = board), lists: () => lists, setLists: (fresh) => (lists = fresh) });

describe('categories', () => {
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
    function renderPick() {
      return renderHook(() => ({ pick: useCategoryPick(), board: useBoardState().board }), { wrapper: SettingsAndDays });
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
      expect(uid).toMatch(/^[0-9a-f]{32}$/);
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

    it('raises the not-saved banner for a failed create, with the category taken off and the board read again', async () => {
      const { result } = renderPick();
      await settle();
      vi.mocked(api.addCategory).mockRejectedValueOnce(new Error('offline'));
      act(() => void result.current.pick!.create('KB'));
      await settle();
      expect(warnSaveFailed).toHaveBeenCalledOnce();
      expect(result.current.pick?.categories).toEqual([TICKETS]);
      expect(api.getBoard).toHaveBeenCalledTimes(2);
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
