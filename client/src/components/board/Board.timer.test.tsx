// @vitest-environment happy-dom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import * as api from '../../api';
import { MAX_PRIORITIES } from '../../../../shared/settings.js';
import { dismissByTag, unlockAudio, warnQuietly, warnSaveFailed } from '../../lib/alerts';
import { withItemPatch } from '../../lib/board';
import { ADD_PRIORITY_FAILED, WARNING_ACTIONS } from '../../lib/copy';
import { deferredAnswer, makeBoard, makeCard, makeSession, QUEUE, settle } from '../../test/hooks';
import type { Board as BoardData, Priority } from '../../types';
import { closeCard, moveTo, NOW, notice, openCard, putLists, renderBoard, REPORT, row, serveBoard, start, titlesIn, TUE, WED } from './Board.testkit';

vi.mock('../../api');
vi.mock('../../lib/alerts');

let onServer: BoardData;
let lists: Record<string, Priority[]>;
serveBoard({ board: () => onServer, setBoard: (board) => (onServer = board), lists: () => lists, setLists: (fresh) => (lists = fresh) });

describe('starting the focus timer', () => {
  /** The open dialog's Start timer, or null. */
  const startGroup = () => screen.queryByRole('group', { name: 'Start timer' });
  /** Presses a length in the open dialog's Start timer. */
  const startFor = (minutes: number) => fireEvent.click(within(startGroup()!).getByRole('button', { name: new RegExp(`^${minutes}\\s*min$`) }));
  /** The uid the last start was handed: a pull's comes once its save answers. */
  const startedOn = () => start.mock.lastCall![3];
  /** The ids a card's button is described by. */
  const describedBy = (title: string) => screen.getByRole('button', { name: title }).getAttribute('aria-describedby')!.split(' ');

  it("starts on today's open row from its dialog, which closes with the focus on the card", async () => {
    await renderBoard();
    openCard('Report');
    expect(
      within(startGroup()!)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['15min', '25min', '50min']);
    startFor(25);
    expect(unlockAudio).toHaveBeenCalledOnce();
    expect(dismissByTag).toHaveBeenCalledWith('break');
    expect(start).toHaveBeenCalledExactlyOnceWith(WED, 25 * 60, 'Report', REPORT);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Report' }));
    await settle();
    expect(api.putPriorities).not.toHaveBeenCalled();
  });

  it("pulls a Next card onto today's list first, and starts on the task once the save answers", async () => {
    const saved = deferredAnswer<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(saved.promise);
    await renderBoard();
    openCard('Follow up');
    startFor(15);
    // Asked at once, so the timer counts the start as out while the pull is on its way.
    expect(start).toHaveBeenCalledExactlyOnceWith(WED, 15 * 60, 'Follow up', expect.any(Promise));
    let uid: string | null | undefined;
    void Promise.resolve(startedOn()).then((u) => {
      uid = u;
    });
    await settle();
    expect(putLists()).toEqual([{ date: WED, texts: ['Report', 'Email', 'Follow up'] }]);
    expect(uid).toBeUndefined();
    saved.resolve({ priorities: (lists[WED] = vi.mocked(api.putPriorities).mock.lastCall![1]) });
    await settle();
    expect(uid).toBe('next00000001');
    expect(titlesIn('In Progress')).toEqual(['Report', 'Follow up']);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Follow up' }));
  });

  it("starts on a card of Later's Repeats once its pull puts the recurring priority on today's list", async () => {
    onServer = { ...onServer, recurring: [QUEUE] };
    await renderBoard();
    openCard('Monitor the queue');
    startFor(25);
    expect(start).toHaveBeenCalledExactlyOnceWith(WED, 25 * 60, 'Monitor the queue', expect.any(Promise));
    await settle();
    expect(putLists()).toEqual([{ date: WED, texts: ['Report', 'Email', 'Monitor the queue'] }]);
    expect(lists[WED]![2]).toMatchObject({ uid: QUEUE.uid, recurring: true });
    await expect(startedOn()).resolves.toBe(QUEUE.uid);
    expect(titlesIn('In Progress')).toEqual(['Report', 'Monitor the queue']);
  });

  it('starts on a task left open on an earlier day the same way, pulled first', async () => {
    onServer = makeBoard(...onServer.cards, makeCard('left00000001', 'Check the logs', { lane: null, listDate: TUE, listed: 1 }));
    await renderBoard();
    openCard('Check the logs');
    startFor(50);
    await settle();
    expect(putLists()).toEqual([{ date: WED, texts: ['Report', 'Email', 'Check the logs'] }]);
    expect(start.mock.lastCall!.slice(0, 3)).toEqual([WED, 50 * 60, 'Check the logs']);
    await expect(startedOn()).resolves.toBe('left00000001');
  });

  it('pulls and starts a Next card with three rows open without the nudge, since starting a timer never asks', async () => {
    lists[WED] = [row(1, 'Report'), row(2, 'Email'), row(3, 'Invoices')];
    await renderBoard();
    openCard('Follow up');
    startFor(25);
    expect(within(notice()).queryByRole('button')).toBeNull();
    await settle();
    expect(putLists()[0]!.texts).toEqual(['Report', 'Email', 'Invoices', 'Follow up']);
    expect(start).toHaveBeenCalledExactlyOnceWith(WED, 25 * 60, 'Follow up', expect.any(Promise));
    await expect(startedOn()).resolves.toBe('next00000001');
  });

  it("takes down a Move to's nudge when a row's Start starts the timer", async () => {
    lists[WED] = [row(1, 'Report'), row(2, 'Email'), row(3, 'Invoices')];
    await renderBoard();
    openCard('Follow up');
    moveTo('progress');
    expect(within(notice()).queryByRole('button', { name: WARNING_ACTIONS.fresh.add })).not.toBeNull();
    openCard('Report');
    startFor(15);
    expect(within(notice()).queryByRole('button', { name: WARNING_ACTIONS.fresh.add })).toBeNull();
    expect(start).toHaveBeenCalledExactlyOnceWith(WED, 15 * 60, 'Report', REPORT);
  });

  it('starts nothing when the pull is refused on a full list, and the banner says why once', async () => {
    lists[WED] = Array.from({ length: MAX_PRIORITIES }, (_, i) => row(i + 1, `Task ${i + 1}`));
    await renderBoard();
    openCard('Follow up');
    startFor(25);
    await settle();
    expect(api.putPriorities).not.toHaveBeenCalled();
    await expect(startedOn()).rejects.toThrow(ADD_PRIORITY_FAILED.full);
    expect(warnQuietly).toHaveBeenCalledExactlyOnceWith({ title: ADD_PRIORITY_FAILED.full, tag: 'board-move' });
    expect(warnSaveFailed).not.toHaveBeenCalled();
  });

  it("offers Start on today's recurring row and a card a later day's list holds too, and none in Done or on an item whose move is on its way", async () => {
    lists[WED] = [row(1, 'Report'), row(2, 'Email', { done: true }), row(3, 'Monitor the queue', { uid: QUEUE.uid, recurring: true })];
    const placed = deferredAnswer<BoardData>();
    vi.mocked(api.editItem).mockReturnValueOnce(placed.promise);
    await renderBoard();
    for (const title of ['Monitor the queue', 'Write a KB', 'Plan B']) {
      openCard(title);
      expect(startGroup()).not.toBeNull();
      closeCard();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Earlier This Week · 2' }));
    for (const title of ['Email', 'Shipped', 'Tuesday row']) {
      openCard(title);
      expect(startGroup()).toBeNull();
      closeCard();
    }
    openCard('Report');
    moveTo('next');
    openCard('Report');
    expect(startGroup()).toBeNull();
    placed.resolve((onServer = withItemPatch(onServer, REPORT, { lane: 'next', before: null })));
    await settle();
    // Parked, it is a card of Next, pulled again by a Start.
    expect(startGroup()).not.toBeNull();
  });

  it('offers no Start while a timer runs, and marks the item it runs on running, or paused, its title naming the mark', async () => {
    await renderBoard(undefined, NOW, { running: makeSession({ date: WED, priorityUid: REPORT }) });
    for (const title of ['Report', 'Follow up', 'Write a KB']) {
      openCard(title);
      expect(startGroup()).toBeNull();
      closeCard();
    }
    const marks = document.querySelectorAll('.board-card-meta .pill');
    expect([...marks].map((m) => m.textContent)).toEqual(['running']);
    expect(marks[0]!.parentElement!.firstElementChild).toBe(marks[0]);
    // Beside the drag's instructions.
    expect(describedBy('Report')).toEqual([marks[0]!.id, expect.stringMatching(/^DndDescribedBy/)]);

    cleanup();
    await renderBoard(undefined, NOW, { running: makeSession({ date: WED, priorityUid: REPORT, pausedAt: NOW }) });
    expect([...document.querySelectorAll('.board-card-meta .pill')].map((m) => m.textContent)).toEqual(['paused']);

    // A session on the task on another day marks nothing today.
    cleanup();
    await renderBoard(undefined, NOW, { running: makeSession({ date: TUE, priorityUid: REPORT }) });
    expect(document.querySelector('.board-card-meta .pill')).toBeNull();
    expect(describedBy('Report')).toEqual([expect.stringMatching(/^DndDescribedBy/)]);

    // A card has no day: a session on its task marks it, whatever day the session started on.
    cleanup();
    await renderBoard(undefined, NOW, { running: makeSession({ date: TUE, priorityUid: 'next00000001' }) });
    const mark = document.querySelector('.board-card-meta .pill')!;
    expect(mark.textContent).toBe('running');
    expect(describedBy('Follow up')).toContain(mark.id);
  });

  it("holds Start while a start is out, and says in the banner when a row's start fails", async () => {
    await renderBoard(undefined, NOW, { starting: true });
    openCard('Report');
    expect(
      within(startGroup()!)
        .getAllByRole('button')
        .every((b) => (b as HTMLButtonElement).disabled),
    ).toBe(true);

    cleanup();
    start.mockRejectedValueOnce(new Error('offline'));
    await renderBoard();
    openCard('Report');
    startFor(25);
    await settle();
    expect(warnSaveFailed).toHaveBeenCalledOnce();
  });
});
