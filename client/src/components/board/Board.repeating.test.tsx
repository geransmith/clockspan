// @vitest-environment happy-dom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import * as api from '../../api';
import { unlockAudio } from '../../lib/alerts';
import { CONFIRM } from '../../lib/copy';
import { deferredAnswer, FOLLOW_UPS, makeBoard, makeRecurring, QUEUE, settle } from '../../test/hooks';
import type { Board as BoardData, Priority } from '../../types';
import { closeCard, column, dialog, moveOptions, moveTo, openCard, putLists, renderBoard, REPORT, row, serveBoard, titlesIn, WED } from './Board.testkit';

vi.mock('../../api');
vi.mock('../../lib/alerts');

let onServer: BoardData;
let lists: Record<string, Priority[]>;
serveBoard({ board: () => onServer, setBoard: (board) => (onServer = board), lists: () => lists, setLists: (fresh) => (lists = fresh) });

describe('repeating', () => {
  const FOLLOW = { ...FOLLOW_UPS, weekdays: [1, 3, 5] };
  /** The open dialog's Repeat row, a day's button in it, and the days pressed. */
  const repeatGroup = () => screen.queryByRole('group', { name: 'Repeat' });
  const day = (name: string) => within(repeatGroup()!).getByRole('button', { name });
  const pressed = () =>
    within(repeatGroup()!)
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-pressed') === 'true')
      .map((b) => b.getAttribute('aria-label'));
  const WORK_WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  /** The confirms, answered yes unless a case says otherwise. */
  let confirm: Mock<(message?: string) => boolean>;

  beforeEach(() => {
    onServer = { ...onServer, recurring: [QUEUE, FOLLOW] };
    confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
  });

  it("lists the recurring priorities off today's list under Repeats at the end of Later, with their days, counted with Later's cards", async () => {
    lists[WED] = [row(1, 'Report'), row(2, 'Monitor the queue', { uid: QUEUE.uid, recurring: true })];
    onServer = { ...onServer, recurring: [QUEUE, FOLLOW, makeRecurring('rec000000003', 'Water the plants', { weekdays: [6, 7] })] };
    await renderBoard();
    expect(titlesIn('Later')).toEqual(['Write a KB', 'Follow-ups', 'Water the plants']);
    expect(within(column('Later')).getByRole('heading', { name: 'Repeats' })).toBeTruthy();
    expect(column('Later').querySelector('.board-col-head .muted')?.textContent).toBe('3');
    const metas = [...column('Later').querySelectorAll('.board-card-meta')];
    expect(metas.map((m) => [m.querySelector('[role="img"]')?.getAttribute('aria-label'), m.textContent])).toEqual([
      ['Repeats', 'Mon, Wed, Fri'],
      ['Repeats', 'Sat, Sun'],
    ]);
    // On today's list, it shows there alone, with its mark and no days.
    expect(titlesIn('In Progress')).toEqual(['Report', 'Monitor the queue']);
    expect(column('In Progress').querySelector('.board-card-meta')?.textContent).toBe('');
  });

  it('says Later has nothing parked only when Repeats is empty too', async () => {
    onServer = { ...makeBoard(), recurring: [FOLLOW] };
    await renderBoard();
    expect(titlesIn('Later')).toEqual(['Follow-ups']);
    expect(within(column('Later')).queryByText(/Nothing parked/)).toBeNull();
    cleanup();
    onServer = makeBoard();
    await renderBoard();
    expect(within(column('Later')).getByText(/Nothing parked/)).toBeTruthy();
    expect(within(column('Later')).queryByRole('heading', { name: 'Repeats' })).toBeNull();
  });

  it('makes a card repeat on the first day pressed, once confirmed, keeping its dialog open on that day, with Stop Repeating in place of Delete', async () => {
    await renderBoard();
    openCard('Write a KB');
    expect(
      within(repeatGroup()!)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
    expect(pressed()).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Stop Repeating' })).toBeNull();
    confirm.mockReturnValueOnce(false);
    fireEvent.click(day('Wednesday'));
    expect(confirm).toHaveBeenCalledExactlyOnceWith(CONFIRM.makeRecurring('Write a KB'));
    await settle();
    expect(api.editItem).not.toHaveBeenCalled();
    const wednesday = day('Wednesday');
    wednesday.focus();
    fireEvent.click(wednesday);
    // It repeats at once: Later's Repeats lists it, and its dialog has no Delete.
    expect(titlesIn('Later')).toEqual(['Monitor the queue', 'Follow-ups', 'Write a KB']);
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    await settle();
    expect(api.editItem).toHaveBeenCalledExactlyOnceWith('later0000001', { weekday: { day: 3, on: true } });
    expect(dialog().getAttribute('aria-label')).toBe('Write a KB');
    expect(document.activeElement).toBe(wednesday);
    expect(pressed()).toEqual(['Wednesday']);
    expect(screen.getByRole('button', { name: 'Stop Repeating' })).toBeTruthy();
    expect(moveOptions()).toEqual(['In Progress', 'Done']);
    // Its days change one at a time from here, asking nothing, and the last one stays on.
    fireEvent.click(day('Monday'));
    await settle();
    expect(api.editItem).toHaveBeenLastCalledWith('later0000001', { weekday: { day: 1, on: true } });
    fireEvent.click(day('Monday'));
    await settle();
    expect(pressed()).toEqual(['Wednesday']);
    expect(day('Wednesday').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(day('Wednesday'));
    await settle();
    expect(api.editItem).toHaveBeenCalledTimes(3);
    expect(confirm).toHaveBeenCalledTimes(2);
    closeCard();
    expect(within(column('Later')).getByText('Wed')).toBeTruthy();
  });

  it("makes today's row repeat, keeping its dialog open, and reads today again", async () => {
    await renderBoard();
    openCard('Report');
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    vi.mocked(api.getDay).mockClear();
    lists[WED] = [row(1, 'Report', { recurring: true }), row(2, 'Email', { done: true })];
    fireEvent.click(day('Friday'));
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove From Today' })).toBeTruthy();
    await settle();
    expect(api.editItem).toHaveBeenCalledExactlyOnceWith(REPORT, { weekday: { day: 5, on: true } });
    expect(api.getDay).toHaveBeenCalledWith(WED);
    expect(dialog().getAttribute('aria-label')).toBe('Report');
    expect(pressed()).toEqual(['Friday']);
    expect(titlesIn('In Progress')).toEqual(['Report']);
    expect(within(column('In Progress')).getByRole('img', { name: 'Repeats' })).toBeTruthy();
    // On today's list, it isn't in Repeats too.
    expect(titlesIn('Later')).toEqual(['Write a KB', 'Monitor the queue', 'Follow-ups']);
  });

  it("makes a row the board hasn't read yet repeat at once, asking only for its first day", async () => {
    lists[WED] = [row(1, 'Report'), row(2, 'Email', { done: true }), row(3, 'Water the plants')];
    const patched = deferredAnswer<BoardData>();
    vi.mocked(api.editItem).mockReturnValueOnce(patched.promise);
    await renderBoard();
    openCard('Water the plants');
    fireEvent.click(day('Friday'));
    await settle();
    expect(pressed()).toEqual(['Friday']);
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    fireEvent.click(day('Monday'));
    expect(confirm).toHaveBeenCalledOnce();
    expect(pressed()).toEqual(['Monday', 'Friday']);
    patched.resolve((onServer = { ...onServer, recurring: [QUEUE, FOLLOW, makeRecurring('row3xxxxxxxx', 'Water the plants', { weekdays: [5] })] }));
    await settle();
    expect(api.editItem).toHaveBeenLastCalledWith('row3xxxxxxxx', { weekday: { day: 1, on: true } });
  });

  it('stops repeating once confirmed: the card leaves the board, the focus on the card after it; turned down, nothing is sent', async () => {
    await renderBoard();
    openCard('Monitor the queue');
    expect(pressed()).toEqual(WORK_WEEK);
    confirm.mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Stop Repeating' }));
    expect(confirm).toHaveBeenCalledExactlyOnceWith(CONFIRM.deleteRecurring('Monitor the queue'));
    expect(dialog()).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop Repeating' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Follow-ups' }));
    await settle();
    expect(api.deleteItem).toHaveBeenCalledExactlyOnceWith(QUEUE.uid);
    expect(titlesIn('Later')).toEqual(['Write a KB', 'Follow-ups']);
  });

  it("stops repeating from today's row, which stays on today's list with the focus on it and no Repeat row", async () => {
    lists[WED] = [row(1, 'Monitor the queue', { uid: QUEUE.uid, recurring: true }), row(2, 'Report')];
    await renderBoard();
    openCard('Monitor the queue');
    expect(pressed()).toEqual(WORK_WEEK);
    fireEvent.click(screen.getByRole('button', { name: 'Stop Repeating' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Monitor the queue' }));
    await settle();
    expect(api.deleteItem).toHaveBeenCalledExactlyOnceWith(QUEUE.uid);
    expect(titlesIn('In Progress')).toEqual(['Monitor the queue', 'Report']);
    openCard('Monitor the queue');
    expect(repeatGroup()).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove From Today' })).toBeTruthy();
  });

  it("offers no Repeat row where the server can't change the task: an earlier day's tick of a stopped routine, an archived task's row", async () => {
    lists[WED] = [row(1, 'Report', { archived: true })];
    await renderBoard();
    openCard('Report');
    expect(repeatGroup()).toBeNull();
    closeCard();
    fireEvent.click(screen.getByRole('button', { name: 'Earlier This Week · 2' }));
    openCard('Tuesday row');
    expect(repeatGroup()).toBeNull();
  });

  it("puts a card of Repeats on today's list with Move to, and ticked with Done", async () => {
    const saved = deferredAnswer<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(saved.promise);
    await renderBoard();
    openCard('Follow-ups');
    expect(moveOptions()).toEqual(['In Progress', 'Done']);
    moveTo('progress');
    // On its way to In Progress, it shows there without the days Repeats lists.
    expect(titlesIn('In Progress')).toEqual(['Report', 'Follow-ups']);
    expect(within(column('In Progress')).queryByText('Mon, Wed, Fri')).toBeNull();
    await settle();
    saved.resolve({ priorities: (lists[WED] = vi.mocked(api.putPriorities).mock.lastCall![1]) });
    await settle();
    expect(putLists()).toEqual([{ date: WED, texts: ['Report', 'Email', 'Follow-ups'] }]);
    expect(lists[WED]![2]).toMatchObject({ uid: FOLLOW.uid, recurring: true, done: false });
    expect(titlesIn('In Progress')).toEqual(['Report', 'Follow-ups']);
    expect(titlesIn('Later')).toEqual(['Write a KB', 'Monitor the queue']);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Follow-ups' }));
    openCard('Monitor the queue');
    moveTo('done');
    expect(unlockAudio).toHaveBeenCalledOnce();
    await settle();
    expect(lists[WED]![3]).toMatchObject({ uid: QUEUE.uid, recurring: true, done: true });
    expect(titlesIn('Done')).toEqual(['Email', 'Monitor the queue', 'Earlier This Week · 2']);
  });
});
