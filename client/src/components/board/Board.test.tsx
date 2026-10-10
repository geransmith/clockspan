// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import * as api from '../../api';
import { BOARD_LIMITS, LOOKBACK_DAYS } from '../../../../shared/api.js';
import { addDays, DAY_MS, HOUR_MS, MINUTE_MS } from '../../../../shared/dates.js';
import { MAX_PRIORITIES } from '../../../../shared/settings.js';
import type { TimerCtx } from '../../hooks/useTimer';
import { dismissByTag, unlockAudio, warnQuietly, warnSaveFailed } from '../../lib/alerts';
import { COLUMN_NAMES, withCategory, withItem, withItemPatch, withoutItem, type ColumnId } from '../../lib/board';
import { ADD_PRIORITY_FAILED, BOARD, BOARD_DRAG, CONFIRM, DONE_STAYS, LOAD_FAILED, PRIORITY_WARNINGS, WARNING_ACTIONS } from '../../lib/copy';
import { USER_KEYS } from '../../lib/storage';
import {
  answered,
  completedSession,
  deferredAnswer,
  makeBoard,
  makeCard,
  makeCategory,
  makeDay,
  makePriority,
  makeSession,
  makeRecurring,
  makeSettings,
  pressKey,
  serveRange,
  settle,
  SettingsAndDays,
  ShortcutKeys,
  stubMatchMedia,
} from '../../test/hooks';
import type { Board as BoardData, Priority, Session } from '../../types';
import { Board } from './Board';

vi.mock('../../api');
vi.mock('../../lib/alerts');

// A Wednesday, so Done has a Monday and a Tuesday before today.
const MON = '2026-09-28';
const TUE = '2026-09-29';
const WED = '2026-09-30';
const THU = '2026-10-01';
const NOW = new Date(2026, 8, 30, 10).getTime();

let onServer: BoardData;
let lists: Record<string, Priority[]>;

/** A task on a day's list; its uid is the task's, `row<position>` unless given. */
const row = (position: number, text: string, patch: Partial<Priority> = {}) =>
  makePriority(position, text, { uid: `row${position}`.padEnd(12, 'x'), ...patch });
/** Today's two tasks, as the board has them too: the server sends every task listed in the last two weeks. */
const REPORT = 'row1xxxxxxxx';
const EMAIL = 'row2xxxxxxxx';
/** A recurring priority's row, ticked on Tuesday. */
const tuesdayRoutine = () => row(1, 'Tuesday row', { uid: 'rec000000009', recurring: true, done: true });
/** Later and Next at the cap. */
const fullBoard = () => Array.from({ length: BOARD_LIMITS.openCards }, (_, i) => makeCard(`c${i}`.padEnd(12, 'x'), `Card ${i}`, { position: i + 1 }));

/** The timer's start as App hands it to the board: it waits for the uid it is given, as `useTimer` does, so a failed pull fails it. */
const start = vi.fn<TimerCtx['start']>();

/**
 * Renders the board at `now`, the minute App hands it, with the timer App hands it (none running,
 * no start out); the answer renders it again at another minute.
 */
async function renderBoard(settings = makeSettings(), now = NOW, { running = null, starting = false }: { running?: Session | null; starting?: boolean } = {}) {
  vi.mocked(api.getSettings).mockResolvedValue(answered(settings));
  const page = (at: number, today: string) => (
    <SettingsAndDays>
      <ShortcutKeys />
      <Board today={today} now={at} running={running} start={start} starting={starting} />
    </SettingsAndDays>
  );
  const { rerender } = render(page(now, WED));
  await settle();
  return (at: number, today = WED) => rerender(page(at, today));
}

/** A column by its heading. */
const column = (name: string) => screen.getByRole('region', { name });
/** The board notice's live region (drag and drop has a live region of its own). */
const notice = () => document.querySelector<HTMLElement>('.board-notice[role="status"]')!;
/** The titles a column shows, in order, and Done's fold. */
const titlesIn = (name: string) => [...column(name).querySelectorAll('.board-card-title, .board-earlier')].map((b) => b.textContent);
/** The open card's dialog. */
const dialog = () => screen.getByRole('dialog');
/** Opens an item's dialog by its card, in the column named when two show the title. Nothing behind an open dialog takes a press in a browser, so none is open. */
const openCard = (title: string, inColumn?: string) => {
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click((inColumn ? within(column(inColumn)) : screen).getByRole('button', { name: title }));
};
/** Closes the open dialog with Escape. */
const closeCard = () => fireEvent.keyDown(dialog(), { key: 'Escape' });
/** Says another device saved a change, which the board answers with a read. */
const changedElsewhere = () => act(() => void window.dispatchEvent(new CustomEvent(api.CHANGED_ELSEWHERE)));
/** The open dialog's Move to, and its column buttons. */
const moveGroup = () => screen.getByRole('group', { name: 'Move to' });
const moveButton = (to: ColumnId) => within(moveGroup()).getByRole('button', { name: COLUMN_NAMES[to] });
const moveTo = (to: ColumnId) => fireEvent.click(moveButton(to));
const moveOptions = () =>
  within(moveGroup())
    .getAllByRole('button')
    .map((b) => b.textContent);
const putLists = () => vi.mocked(api.putPriorities).mock.calls.map(([date, list]) => ({ date, texts: list.map((p) => p.text) }));
/** The tasks a lane's box and Add a new card sent. */
const added = () => vi.mocked(api.addItem).mock.calls.map(([item]) => item);
/** A column's + by its heading. */
const plus = (name: string) => screen.getByRole('button', { name: `Add to ${name}` });
/** A column's box by its field's name. */
const field = (name: string) => screen.getByRole('textbox', { name }) as HTMLInputElement;
const isOpen = (name: string) => screen.queryByRole('textbox', { name }) !== null;
/** Types into a box and presses Enter. */
const enter = (box: HTMLElement, text: string) => {
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: 'Enter' });
};
/** The columns a phone shows, one at a time. */
const shownColumns = () => [...document.querySelectorAll('.board-col[data-shown]')].map((c) => c.querySelector('h2')!.textContent);

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  onServer = makeBoard(
    makeCard('later0000001', 'Write a KB'),
    makeCard('next00000001', 'Follow up', { lane: 'next' }),
    makeCard('planned00001', 'Plan B', { lane: 'next', position: 2, listDate: THU, listed: 1 }),
    makeCard('done00000001', 'Shipped', { lane: null, listDate: TUE, listDone: true, listed: 1 }),
    makeCard(REPORT, 'Report', { lane: null, listDate: WED, listed: 1 }),
    makeCard(EMAIL, 'Email', { lane: null, listDate: WED, listDone: true, listed: 1 }),
  );
  lists = { [WED]: [row(1, 'Report'), row(2, 'Email', { done: true })] };
  vi.mocked(api.getDay).mockImplementation((date) => Promise.resolve(answered(makeDay(date, { priorities: lists[date] ?? [] }))));
  serveRange([makeDay(TUE, { priorities: [tuesdayRoutine()] }), makeDay(MON)]);
  vi.mocked(api.putPriorities).mockImplementation((date, list) => Promise.resolve(answered({ priorities: (lists[date] = list) })));
  vi.mocked(api.getBoard).mockImplementation(() => Promise.resolve(answered(onServer)));
  vi.mocked(api.addItem).mockImplementation((item) => Promise.resolve(answered((onServer = withItem(onServer, item, NOW)))));
  vi.mocked(api.editItem).mockImplementation((uid, patch) => Promise.resolve(answered((onServer = withItemPatch(onServer, uid, patch)))));
  vi.mocked(api.deleteItem).mockImplementation((uid) => Promise.resolve(answered((onServer = withoutItem(onServer, uid)))));
  start.mockImplementation(async (_date, _seconds, _label, uid) => {
    await uid;
  });
});

describe('Board', () => {
  it("shows Later, Next, today's open rows in progress and this week in Done", async () => {
    await renderBoard();
    expect(titlesIn('Later')).toEqual(['Write a KB']);
    expect(titlesIn('Next')).toEqual(['Follow up', 'Plan B']);
    expect(titlesIn('In progress')).toEqual(['Report']);
    expect(titlesIn('Done')).toEqual(['Email', 'Earlier this week · 2']);
    fireEvent.click(screen.getByRole('button', { name: 'Earlier this week · 2' }));
    expect(titlesIn('Done')).toEqual(['Email', 'Earlier this week · 2', 'Shipped', 'Tuesday row']);
    expect(screen.getByRole('button', { name: 'Earlier this week · 2' }).getAttribute('aria-expanded')).toBe('true');
  });

  it("puts today's times above the notice and the columns, only with Times on the board on", async () => {
    await renderBoard();
    const board = document.querySelector('.board')!;
    expect(board.firstElementChild).toBe(screen.getByRole('region', { name: 'Timeclock' }));
    cleanup();
    await renderBoard(makeSettings({ clockBar: false }));
    expect(screen.queryByRole('region', { name: 'Timeclock' })).toBeNull();
  });

  it('shows a task left open in the last two weeks in Next after its own tasks, saying when, and Move to Next gives it a place', async () => {
    onServer = makeBoard(
      ...onServer.cards,
      makeCard('left00000001', 'Check the logs', { lane: null, listDate: TUE, listed: 1 }),
      makeCard('left00000002', 'Too old', { lane: null, listDate: addDays(WED, -(LOOKBACK_DAYS + 1)), listed: 1 }),
    );
    await renderBoard();
    expect(titlesIn('Next')).toEqual(['Follow up', 'Plan B', 'Check the logs']);
    expect(within(column('Next')).getByText('Left open from yesterday')).toBeTruthy();
    expect(screen.queryByText('Too old')).toBeNull();
    openCard('Check the logs');
    expect(screen.getByRole('textbox', { name: 'Title' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Category for Check the logs: none' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    // Next too: it has no place of its own there yet.
    expect(moveOptions()).toEqual(['Later', 'Next', 'In progress', 'Done']);
    moveTo('next');
    await settle();
    expect(api.editItem).toHaveBeenCalledExactlyOnceWith('left00000001', { lane: 'next', before: null });
    expect(titlesIn('Next')).toEqual(['Follow up', 'Plan B', 'Check the logs']);
    expect(within(column('Next')).queryByText('Left open from yesterday')).toBeNull();
  });

  it('moves a task between Later and Next with Move to', async () => {
    await renderBoard();
    openCard('Write a KB');
    expect(moveOptions()).toEqual(['Next', 'In progress', 'Done']);
    moveTo('next');
    await settle();
    expect(api.editItem).toHaveBeenCalledExactlyOnceWith('later0000001', { lane: 'next', before: null });
    expect(titlesIn('Next')).toEqual(['Follow up', 'Plan B', 'Write a KB']);
  });

  it("pulls a task into In progress: the task itself on today's list", async () => {
    await renderBoard();
    openCard('Follow up');
    moveTo('progress');
    await settle();
    expect(putLists()).toEqual([{ date: WED, texts: ['Report', 'Email', 'Follow up'] }]);
    expect(lists[WED]![2]).toMatchObject({ uid: 'next00000001', done: false });
    expect(titlesIn('In progress')).toEqual(['Report', 'Follow up']);
  });

  it('puts a Next task in Done as a ticked row of today, unlocking the sound in the tap', async () => {
    await renderBoard();
    openCard('Follow up');
    // The burst starts at the button pressed, measured before it goes with the dialog.
    moveButton('done').getBoundingClientRect = () => ({ left: 100, top: 200, width: 80, height: 44 }) as DOMRect;
    moveTo('done');
    expect(unlockAudio).toHaveBeenCalledTimes(1);
    expect((document.querySelector('.burst') as HTMLElement).style).toMatchObject({ left: '140px', top: '222px' });
    await settle();
    expect(lists[WED]![2]).toMatchObject({ text: 'Follow up', done: true, uid: 'next00000001' });
    expect(titlesIn('Done')).toEqual(['Email', 'Follow up', 'Earlier this week · 2']);
  });

  it("ticks today's rows from the board, unlocking the sound for a tick", async () => {
    await renderBoard();
    const box = screen.getByRole('checkbox', { name: 'Report done' });
    // The checkbox goes to Done with its row in the same render, and a node out of the page
    // measures 0 × 0 at the corner: the burst starts where it was tapped, measured then.
    box.getBoundingClientRect = () => (box.isConnected ? { left: 100, top: 200, width: 20, height: 20 } : { left: 0, top: 0, width: 0, height: 0 }) as DOMRect;
    fireEvent.click(box);
    expect(unlockAudio).toHaveBeenCalledTimes(1);
    expect((document.querySelector('.burst') as HTMLElement).style).toMatchObject({ left: '110px', top: '210px' });
    await settle();
    expect(putLists()).toEqual([{ date: WED, texts: ['Report', 'Email', ''] }]);
    expect(lists[WED]![0]!.done).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Email done' }));
    await settle();
    expect(lists[WED]![1]!.done).toBe(false);
    expect(unlockAudio).toHaveBeenCalledTimes(1);
  });

  it('gives a task done on an earlier day no tick, saying where to untick it, and Move to brings it back', async () => {
    await renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Earlier this week · 2' }));
    expect(screen.queryByRole('checkbox', { name: 'Shipped done' })).toBeNull();
    openCard('Shipped');
    expect(dialog().getAttribute('aria-label')).toBe('Shipped');
    expect(within(dialog()).getByText(BOARD.doneOn('yesterday'))).toBeTruthy();
    expect(within(dialog()).getByRole('textbox', { name: 'Title' })).toBeTruthy();
    expect(within(dialog()).getByRole('button', { name: 'Category for Shipped: none' })).toBeTruthy();
    expect(within(dialog()).getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(moveOptions()).toEqual(['Later', 'Next', 'In progress']);
    moveTo('progress');
    await settle();
    expect(lists[WED]![2]).toMatchObject({ uid: 'done00000001', text: 'Shipped', done: false });
    expect(titlesIn('In progress')).toEqual(['Report', 'Shipped']);
    // Today's ticked row keeps its tick and its Delete.
    openCard('Email');
    expect(screen.getByRole('checkbox', { name: 'Email done' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
  });

  it('renames a task done on an earlier day by a PATCH, and deletes it everywhere with a confirm counting its days and time', async () => {
    onServer = makeBoard(...onServer.cards.map((c) => (c.uid === 'done00000001' ? { ...c, listed: 2, logged: 25 * 60 } : c)));
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    await renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Earlier this week · 2' }));
    openCard('Shipped');
    const title = screen.getByRole('textbox', { name: 'Title' });
    fireEvent.change(title, { target: { value: 'Shipped v2' } });
    fireEvent.keyDown(title, { key: 'Enter' });
    await settle();
    expect(api.editItem).toHaveBeenCalledExactlyOnceWith('done00000001', { title: 'Shipped v2' });
    expect(titlesIn('Done')).toEqual(['Email', 'Earlier this week · 2', 'Shipped v2', 'Tuesday row']);

    openCard('Shipped v2');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(confirm).toHaveBeenCalledWith(CONFIRM.deleteTask(2, '25m'));
    await settle();
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(api.deleteItem).toHaveBeenCalledExactlyOnceWith('done00000001');
    expect(titlesIn('Done')).toEqual(['Email', 'Earlier this week · 1', 'Tuesday row']);
  });

  it("parks today's row: its task placed in Later first, then the row off today's list", async () => {
    await renderBoard();
    openCard('Report');
    moveTo('later');
    await settle();
    expect(api.editItem).toHaveBeenCalledExactlyOnceWith(REPORT, { lane: 'later', before: 'later0000001' });
    expect(putLists()).toEqual([{ date: WED, texts: ['', 'Email', ''] }]);
    expect(vi.mocked(api.editItem).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.putPriorities).mock.invocationCallOrder[0]!);
    expect(titlesIn('Later')).toEqual(['Report', 'Write a KB']);
    expect(titlesIn('In progress')).toEqual([]);
    expect(screen.getByText("Nothing open on today's list.")).toBeTruthy();
  });

  it('puts the focus on the moved item once it lands, when the move left it nowhere', async () => {
    await renderBoard();
    openCard('Report');
    // The dialog closes with the focus on the card, which goes to Later with its item.
    moveButton('later').focus();
    moveTo('later');
    expect(screen.queryByRole('dialog')).toBeNull();
    await settle();
    expect(titlesIn('Later')).toEqual(['Report', 'Write a KB']);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Report' }));
  });

  it('leaves the focus where the user put it while a park was on its way', async () => {
    const placed = deferredAnswer<BoardData>();
    vi.mocked(api.editItem).mockReturnValueOnce(placed.promise);
    await renderBoard();
    openCard('Report');
    moveTo('later');
    fireEvent.click(plus('Later'));
    const box = field('New card for Later');
    placed.resolve((onServer = withItemPatch(onServer, REPORT, { lane: 'later', before: 'later0000001' })));
    await settle();
    expect(titlesIn('Later')).toEqual(['Report', 'Write a KB']);
    expect(document.activeElement).toBe(box);
  });

  it('holds a pull onto a list already at the nudge until Add anyway, and Keep it short sends nothing', async () => {
    lists[WED] = [row(1, 'Report'), row(2, 'Email'), row(3, 'Invoices')];
    await renderBoard();
    openCard('Follow up');
    moveTo('progress');
    const box = notice();
    expect(PRIORITY_WARNINGS.fresh).toContain(within(box).getByText(/./, { selector: 'span:not(.notice-actions)' }).textContent);
    // The dialog closed first, so the notice can take the focus: a modal leaves the page inert.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(within(box).getByRole('button', { name: WARNING_ACTIONS.fresh.add }));
    fireEvent.click(within(box).getByRole('button', { name: WARNING_ACTIONS.fresh.keep }));
    await settle();
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(within(notice()).queryByRole('button')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Follow up' }));
    // The next move replaces the notice.
    openCard('Follow up');
    moveTo('progress');
    fireEvent.click(within(notice()).getByRole('button', { name: WARNING_ACTIONS.fresh.add }));
    await settle();
    expect(putLists()[0]!.texts).toEqual(['Report', 'Email', 'Invoices', 'Follow up']);
    // A drop into Done asks nothing.
    openCard('Write a KB');
    moveTo('done');
    await settle();
    expect(api.putPriorities).toHaveBeenCalledTimes(2);
  });

  it("puts a pulled task in a free row of today's list with no question, as Add priority does, and asks once none is left", async () => {
    // Row 3 was taken off.
    lists[WED] = [row(1, 'Report'), row(2, 'Email'), row(4, 'Invoices')];
    await renderBoard();
    openCard('Follow up');
    moveTo('progress');
    expect(notice().textContent).toBe('');
    await settle();
    expect(putLists()).toEqual([{ date: WED, texts: ['Report', 'Email', 'Follow up', 'Invoices'] }]);
    openCard('Write a KB');
    moveTo('progress');
    expect(PRIORITY_WARNINGS.fresh).toContain(within(notice()).getByText(/./, { selector: 'span:not(.notice-actions)' }).textContent);
  });

  describe('a done item moved to Later or Next', () => {
    it('stays done: the notice says so and sends nothing', async () => {
      await renderBoard();
      openCard('Email');
      moveTo('next');
      const box = notice();
      expect(box.textContent).toContain(DONE_STAYS.title('Email'));
      expect(box.textContent).toContain(DONE_STAYS.body);
      // The notice takes the focus, so a keyboard user reaches its buttons.
      expect(document.activeElement).toBe(within(box).getByRole('button', { name: DONE_STAYS.add('Next') }));
      await settle();
      expect(api.putPriorities).not.toHaveBeenCalled();
      expect(api.addItem).not.toHaveBeenCalled();
      expect(api.editItem).not.toHaveBeenCalled();
    });

    it('Add a new card posts a new task with the same title and category in that lane, and the item stays done', async () => {
      lists[WED]![1] = { ...lists[WED]![1]!, categoryUid: 'cafe00000001' };
      await renderBoard();
      openCard('Email');
      moveTo('next');
      fireEvent.click(screen.getByRole('button', { name: DONE_STAYS.add('Next') }));
      await settle();
      expect(api.addItem).toHaveBeenCalledTimes(1);
      const { uid, ...item } = added()[0]!;
      expect(item).toEqual({ title: 'Email', categoryUid: 'cafe00000001', lane: 'next', before: null });
      // A task of its own, not the done one.
      expect(uid).toMatch(/^[0-9a-f]{12}$/);
      expect(uid).not.toBe(EMAIL);
      expect(titlesIn('Done')).toContain('Email');
      expect(titlesIn('Next')).toEqual(['Follow up', 'Plan B', 'Email']);
      // Later's new task goes at the top, as Later's + puts one.
      fireEvent.click(screen.getByRole('button', { name: 'Earlier this week · 2' }));
      openCard('Shipped');
      moveTo('later');
      fireEvent.click(screen.getByRole('button', { name: DONE_STAYS.add('Later') }));
      await settle();
      expect(added().at(-1)).toMatchObject({ title: 'Shipped', lane: 'later', before: 'later0000001' });
    });

    it('takes the title the box saved as the dialog closed, with the focus still in it as Move to is pressed (Safari)', async () => {
      await renderBoard();
      openCard('Email');
      const title = screen.getByRole('textbox', { name: 'Title' });
      act(() => title.focus());
      fireEvent.change(title, { target: { value: 'Email v2' } });
      moveTo('later');
      expect(notice().textContent).toContain(DONE_STAYS.title('Email v2'));
      fireEvent.click(screen.getByRole('button', { name: DONE_STAYS.add('Later') }));
      await settle();
      expect(putLists()).toEqual([{ date: WED, texts: ['Report', 'Email v2', ''] }]);
      expect(added()[0]).toMatchObject({ title: 'Email v2', lane: 'later' });
    });

    it("Leave it and Escape close the notice, send nothing and put the focus back on the item's card", async () => {
      await renderBoard();
      openCard('Email');
      moveTo('later');
      fireEvent.click(screen.getByRole('button', { name: DONE_STAYS.leave }));
      expect(within(notice()).queryByRole('button')).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Email' }));
      openCard('Email');
      moveTo('next');
      fireEvent.keyDown(screen.getByRole('button', { name: DONE_STAYS.leave }), { key: 'Escape' });
      expect(within(notice()).queryByRole('button')).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Email' }));
      await settle();
      expect(api.addItem).not.toHaveBeenCalled();
    });
  });

  it("offers a recurring row no Later or Next, only Remove from today, which takes it off today's list, closing its dialog with the focus near it, a failed remove too", async () => {
    lists[WED] = [row(1, 'Monitor the queue', { uid: 'rec000000001', recurring: true })];
    await renderBoard();
    openCard('Monitor the queue');
    expect(moveOptions()).toEqual(['Done']);
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    vi.mocked(api.putPriorities).mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove from today' }));
    await settle();
    // The day store put the row back and read the day again.
    expect(titlesIn('In progress')).toEqual(['Monitor the queue']);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(plus('In progress'));
    openCard('Monitor the queue');
    fireEvent.click(screen.getByRole('button', { name: 'Remove from today' }));
    await settle();
    expect(putLists()).toEqual([
      { date: WED, texts: ['', '', ''] },
      { date: WED, texts: ['', '', ''] },
    ]);
    expect(titlesIn('In progress')).toEqual([]);
    expect(document.activeElement).toBe(plus('In progress'));
    expect(api.deleteItem).not.toHaveBeenCalled();
  });

  /** The lines under the title in the open dialog: where it is renamed, or changed. */
  const dialogLines = () => [...dialog().querySelectorAll('p.muted.small')].map((p) => p.textContent);

  it("renames today's recurring row through the row, which renames the recurring priority and its earlier ticks at once, and keeps its chip, its tick and Remove from today", async () => {
    onServer = { ...onServer, recurring: [makeRecurring('rec000000001', 'Monitor the queue')] };
    lists[WED] = [row(1, 'Monitor the queue', { uid: 'rec000000001', recurring: true, listed: 2 }), row(2, 'Report')];
    serveRange([makeDay(TUE, { priorities: [row(1, 'Monitor the queue', { uid: 'rec000000001', recurring: true, done: true })] })]);
    await renderBoard();
    openCard('Monitor the queue');
    expect(dialogLines()).toEqual([]);
    expect(within(dialog()).getByRole('button', { name: 'Category for Monitor the queue: none' })).toBeTruthy();
    expect(within(dialog()).getByRole('button', { name: 'Remove from today' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Monitor the queue done' })).toBeTruthy();
    const title = within(dialog()).getByRole('textbox', { name: 'Title' });
    fireEvent.change(title, { target: { value: 'Watch the queue' } });
    fireEvent.keyDown(title, { key: 'Enter' });
    await settle();
    expect(putLists()).toEqual([{ date: WED, texts: ['Watch the queue', 'Report', ''] }]);
    expect(api.editItem).not.toHaveBeenCalled();
    // Tuesday's tick shows its recurring priority's new name, and the days on screen are read again.
    fireEvent.click(screen.getByRole('button', { name: 'Earlier this week · 2' }));
    expect(titlesIn('Done')).toEqual(['Earlier this week · 2', 'Shipped', 'Watch the queue']);
    expect(vi.mocked(api.getRange)).toHaveBeenCalledTimes(2);
  });

  it("renames today's recurring row through the row once its recurring priority stopped repeating too", async () => {
    lists[WED] = [row(1, 'Monitor the queue', { uid: 'rec000000001', recurring: true })];
    await renderBoard();
    openCard('Monitor the queue');
    expect(dialogLines()).toEqual([]);
    const title = screen.getByRole('textbox', { name: 'Title' });
    fireEvent.change(title, { target: { value: 'Watch the queue' } });
    fireEvent.keyDown(title, { key: 'Enter' });
    await settle();
    expect(putLists()).toEqual([{ date: WED, texts: ['Watch the queue', '', ''] }]);
    expect(api.editItem).not.toHaveBeenCalled();
  });

  it("renames an earlier day's recurring row in Done by a PATCH of its recurring priority, and shows it as text once that stopped repeating", async () => {
    onServer = { ...onServer, recurring: [makeRecurring('rec000000009', 'Tuesday row')] };
    await renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Earlier this week · 2' }));
    openCard('Tuesday row', 'Done');
    expect(dialogLines()).toEqual([]);
    expect(moveOptions()).toEqual(['In progress']);
    const title = screen.getByRole('textbox', { name: 'Title' });
    fireEvent.change(title, { target: { value: 'Tuesday task' } });
    fireEvent.keyDown(title, { key: 'Enter' });
    await settle();
    expect(api.editItem).toHaveBeenCalledExactlyOnceWith('rec000000009', { title: 'Tuesday task' });
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(onServer.recurring[0]!.title).toBe('Tuesday task');
    expect(titlesIn('Done')).toEqual(['Email', 'Earlier this week · 2', 'Shipped', 'Tuesday task']);

    cleanup();
    onServer = { ...onServer, recurring: [] };
    await renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Earlier this week · 2' }));
    openCard('Tuesday row');
    expect(screen.queryByRole('textbox', { name: 'Title' })).toBeNull();
    expect(within(dialog()).getByRole('heading', { name: 'Tuesday row' })).toBeTruthy();
    expect(dialogLines()).toEqual([]);
    // Stopped, it doesn't go back on today's list.
    expect(screen.queryByRole('group', { name: 'Move to' })).toBeNull();
  });

  it('marks a recurring row on its meta line, and only that row', async () => {
    lists[WED] = [row(1, 'Monitor the queue', { uid: 'rec000000001', recurring: true }), row(2, 'Report')];
    await renderBoard();
    const metas = [...column('In progress').querySelectorAll('.board-card-meta')];
    expect(metas).toHaveLength(1);
    expect(
      within(metas[0] as HTMLElement)
        .getByRole('img', { name: 'Repeats' })
        .getAttribute('title'),
    ).toBe('Repeats');
    expect(metas[0]!.closest('.board-card')?.querySelector('.board-card-title')?.textContent).toBe('Monitor the queue');
  });

  it("treats a task a later day's list holds as any card: Move to, a rename by a PATCH, and Delete everywhere with a confirm that counts its days", async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    await renderBoard();
    openCard('Plan B');
    expect(moveOptions()).toEqual(['Later', 'In progress', 'Done']);
    const title = screen.getByRole('textbox', { name: 'Title' });
    fireEvent.change(title, { target: { value: 'Plan C' } });
    fireEvent.blur(title);
    await settle();
    expect(api.editItem).toHaveBeenCalledExactlyOnceWith('planned00001', { title: 'Plan C' });
    expect(titlesIn('Next')).toEqual(['Follow up', 'Plan C']);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(confirm).toHaveBeenCalledWith(CONFIRM.deleteTask(1, null));
    await settle();
    // The server takes it off every day's list: nothing here sends a list.
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(api.deleteItem).toHaveBeenCalledExactlyOnceWith('planned00001');
    expect(titlesIn('Next')).toEqual(['Follow up']);
  });

  it("deletes today's task with a confirm counting its days and time from its row and today's log, the server taking its row off, and nothing when turned down", async () => {
    lists[WED]![0] = { ...lists[WED]![0]!, listed: 3, logged: 60 * 60 };
    const getDay = vi.mocked(api.getDay).getMockImplementation()!;
    vi.mocked(api.getDay).mockImplementation(async (date) =>
      answered({
        ...(await getDay(date)).value,
        sessions: date === WED ? [completedSession(1, NOW - HOUR_MS, 20 * 60, { priorityUid: REPORT })] : [],
      }),
    );
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    await renderBoard();
    openCard('Report');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(confirm).toHaveBeenCalledWith(CONFIRM.deleteTask(3, '1h 20m'));
    await settle();
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(api.deleteItem).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    // The server takes it off every day's list, today's included.
    vi.mocked(api.deleteItem).mockImplementationOnce((uid) => {
      lists[WED] = lists[WED]!.filter((p) => p.uid !== uid);
      return Promise.resolve(answered((onServer = withoutItem(onServer, uid))));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await settle();
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(api.deleteItem).toHaveBeenCalledExactlyOnceWith(REPORT);
    expect(titlesIn('In progress')).toEqual([]);
  });

  it("counts a timer running on today's task in Delete's confirm, as × on the sheet does", async () => {
    lists[WED]![0] = { ...lists[WED]![0]!, listed: 2, logged: 5 * 60 };
    const getDay = vi.mocked(api.getDay).getMockImplementation()!;
    vi.mocked(api.getDay).mockImplementation(async (date) =>
      answered({
        ...(await getDay(date)).value,
        sessions: date === WED ? [makeSession({ date: WED, startedAt: NOW - 10 * MINUTE_MS, priorityUid: REPORT })] : [],
      }),
    );
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    const at = await renderBoard();
    openCard('Report');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(confirm).toHaveBeenLastCalledWith(CONFIRM.deleteTask(2, '15m'));
    // It counts to the minute App hands it, the one the sheet's × reads.
    at(NOW + MINUTE_MS);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(confirm).toHaveBeenLastCalledWith(CONFIRM.deleteTask(2, '16m'));
  });

  it("puts the focus on the next item in the column after a Delete, else the one before, else the column's + or Done's heading", async () => {
    vi.stubGlobal('confirm', () => true);
    onServer = makeBoard(...onServer.cards, makeCard('next00000002', 'Call back', { lane: 'next', position: 3 }));
    await renderBoard();
    expect(titlesIn('Next')).toEqual(['Follow up', 'Plan B', 'Call back']);
    openCard('Follow up');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await settle();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Plan B' }));
    openCard('Call back');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await settle();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Plan B' }));
    openCard('Write a KB');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await settle();
    expect(titlesIn('Later')).toEqual([]);
    expect(document.activeElement).toBe(plus('Later'));
    // Done has no +, and the items folded under Earlier this week take no focus: its heading does.
    vi.mocked(api.deleteItem).mockImplementationOnce((uid) => {
      lists[WED] = lists[WED]!.filter((p) => p.uid !== uid);
      return Promise.resolve(answered((onServer = withoutItem(onServer, uid))));
    });
    openCard('Email');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await settle();
    expect(titlesIn('Done')).toEqual(['Earlier this week · 2']);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Done' }));
    // happy-dom focuses any heading; a browser only one with a tabindex.
    expect(screen.getByRole('heading', { name: 'Done' }).getAttribute('tabindex')).toBe('-1');
  });

  it("shows today's row parked in a lane where it lands, with no tick, rename, category or Remove until the park lands", async () => {
    onServer = makeBoard(...onServer.cards, makeCard('left00000001', 'Check the logs', { lane: null, listDate: TUE, listed: 1 }));
    const placed = deferredAnswer<BoardData>();
    vi.mocked(api.editItem).mockReturnValueOnce(placed.promise);
    await renderBoard();
    openCard('Report');
    moveTo('next');
    // At the end of Next's own tasks, ahead of the one left open.
    expect(titlesIn('Next')).toEqual(['Follow up', 'Plan B', 'Report', 'Check the logs']);
    openCard('Report');
    expect(screen.queryByRole('checkbox', { name: 'Report done' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Title' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Category for Report/ })).toBeNull();
    placed.resolve((onServer = withItemPatch(onServer, REPORT, { lane: 'next', before: null })));
    await settle();
    expect(titlesIn('Next')).toEqual(['Follow up', 'Plan B', 'Report', 'Check the logs']);
    // The dialog left open takes them once it lands.
    expect(screen.getByRole('textbox', { name: 'Title' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Category for Report: none' })).toBeTruthy();
  });

  it("parks today's row whose task a later day's list holds in Later, as any other", async () => {
    onServer = makeBoard(...onServer.cards.filter((c) => c.uid !== REPORT), makeCard(REPORT, 'Report', { lane: null, listDate: THU, listed: 2 }));
    await renderBoard();
    openCard('Report');
    moveTo('later');
    await settle();
    expect(api.editItem).toHaveBeenCalledExactlyOnceWith(REPORT, { lane: 'later', before: 'later0000001' });
    expect(putLists()).toEqual([{ date: WED, texts: ['', 'Email', ''] }]);
    expect(titlesIn('Later')).toEqual(['Report', 'Write a KB']);
  });

  it('renames a task off today or a row of today from its dialog: Enter saves and closes, Escape drops the edit and closes, leaving the box saves', async () => {
    await renderBoard();
    openCard('Write a KB');
    const title = screen.getByRole('textbox', { name: 'Title' });
    act(() => title.focus());
    fireEvent.change(title, { target: { value: 'Write the SSO KB' } });
    // Enter saves once and closes the dialog with the focus on the card; the blur that closing
    // brings saves nothing more. Its default is prevented: the keypress would press the card.
    expect(fireEvent.keyDown(title, { key: 'Enter' })).toBe(false);
    await settle();
    expect(api.editItem).toHaveBeenCalledExactlyOnceWith('later0000001', { title: 'Write the SSO KB' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Write the SSO KB' }));

    openCard('Report');
    const rowTitle = screen.getByRole('textbox', { name: 'Title' });
    act(() => rowTitle.focus());
    fireEvent.change(rowTitle, { target: { value: 'Not this' } });
    // An input method's Escape is the input method's.
    fireEvent.keyDown(rowTitle, { key: 'Escape', isComposing: true });
    expect(dialog()).toBeTruthy();
    fireEvent.keyDown(rowTitle, { key: 'Escape' });
    await settle();
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Report' }));

    openCard('Report');
    const again = screen.getByRole('textbox', { name: 'Title' });
    fireEvent.change(again, { target: { value: 'Report v2' } });
    fireEvent.blur(again);
    await settle();
    expect(putLists()).toEqual([{ date: WED, texts: ['Report v2', 'Email', ''] }]);
    expect(dialog()).toBeTruthy();
  });

  it('saves a title and a note being typed as the dialog closes by its × or a press outside, with the focus on the card', async () => {
    await renderBoard();
    openCard('Write a KB');
    const title = screen.getByRole('textbox', { name: 'Title' });
    act(() => title.focus());
    fireEvent.change(title, { target: { value: 'Write the SSO KB' } });
    // Safari doesn't focus a button it presses, so the focus is still in the box.
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }));
    await settle();
    expect(api.editItem).toHaveBeenCalledExactlyOnceWith('later0000001', { title: 'Write the SSO KB' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Write the SSO KB' }));

    openCard('Write the SSO KB');
    const note = screen.getByRole('textbox', { name: 'Note for Write the SSO KB' });
    act(() => note.focus());
    fireEvent.change(note, { target: { value: 'Ask Kim' } });
    // A press on the backdrop lands on the dialog itself.
    fireEvent.mouseDown(dialog());
    await settle();
    expect(vi.mocked(api.editItem).mock.lastCall).toEqual(['later0000001', { note: 'Ask Kim' }]);
    expect(api.editItem).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Write the SSO KB' }));
  });

  it('follows a move made elsewhere in a dialog left open, and closes it for good once its item goes', async () => {
    await renderBoard();
    openCard('Write a KB');
    expect(moveOptions()).toEqual(['Next', 'In progress', 'Done']);
    onServer = withItemPatch(onServer, 'later0000001', { lane: 'next', before: null });
    changedElsewhere();
    await settle();
    expect(titlesIn('Next')).toEqual(['Follow up', 'Plan B', 'Write a KB']);
    expect(moveOptions()).toEqual(['Later', 'In progress', 'Done']);
    const before = onServer;
    onServer = withoutItem(onServer, 'later0000001');
    changedElsewhere();
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    // Back again (a read that missed it), it doesn't open by itself.
    onServer = before;
    changedElsewhere();
    await settle();
    expect(titlesIn('Next')).toEqual(['Follow up', 'Plan B', 'Write a KB']);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it("closes a dialog as the next day loads, and doesn't open it again once it has", async () => {
    const at = await renderBoard();
    openCard('Write a KB');
    at(NOW + DAY_MS, THU);
    expect(screen.queryByRole('dialog')).toBeNull();
    await settle();
    expect(titlesIn('Later')).toEqual(['Write a KB']);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says a move the store turned down in a banner', async () => {
    await renderBoard();
    vi.mocked(api.editItem).mockRejectedValueOnce(new Error('offline'));
    openCard('Write a KB');
    moveTo('next');
    await settle();
    expect(warnSaveFailed).toHaveBeenCalledOnce();
    expect(titlesIn('Later')).toEqual(['Write a KB']);
  });

  it('says why in the banner when the store refuses a move at the cap, sending nothing', async () => {
    onServer = makeBoard(...fullBoard(), makeCard(REPORT, 'Report', { lane: null, listDate: WED, listed: 1 }));
    await renderBoard();
    openCard('Report');
    moveTo('next');
    await settle();
    expect(warnQuietly).toHaveBeenCalledWith({ title: BOARD.full, tag: 'board-move' });
    expect(warnSaveFailed).not.toHaveBeenCalled();
    expect(api.editItem).not.toHaveBeenCalled();
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(titlesIn('In progress')).toEqual(['Report']);
  });

  it('shows a Try again for a list of today that could not be read', async () => {
    vi.mocked(api.getDay).mockRejectedValueOnce(new Error('offline'));
    await renderBoard();
    expect(screen.getByText(new RegExp(LOAD_FAILED.title))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();
    expect(titlesIn('In progress')).toEqual(['Report']);
  });

  it('shows one column at a time from the switch, In progress first', async () => {
    await renderBoard();
    expect(shownColumns()).toEqual(['In progress']);
    fireEvent.click(within(screen.getByRole('group', { name: 'Board column' })).getByRole('button', { name: 'Later' }));
    expect(shownColumns()).toEqual(['Later']);
  });

  it('shows a Try again for a board that could not be read', async () => {
    vi.mocked(api.getBoard).mockRejectedValue(new Error('offline'));
    await renderBoard();
    expect(screen.getByText(new RegExp(LOAD_FAILED.board))).toBeTruthy();
    vi.mocked(api.getBoard).mockImplementation(() => Promise.resolve(answered(onServer)));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();
    expect(titlesIn('Later')).toEqual(['Write a KB']);
  });
});

describe('adding from a column', () => {
  it("adds a card at the top of Later or the end of Next from the column's +, keeping the box open for the next", async () => {
    await renderBoard();
    // No box is open until a + is pressed, and Done has no +.
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add to Done' })).toBeNull();
    fireEvent.click(plus('Later'));
    const later = field('New card for Later');
    expect(document.activeElement).toBe(later);
    expect(later.placeholder).toBe('New card');
    enter(later, '  Look into the export  ');
    expect(later.value).toBe('');
    expect(document.activeElement).toBe(later);
    // Pressed again, the + only gives its box the focus.
    fireEvent.change(later, { target: { value: 'Half typed' } });
    plus('Later').focus();
    fireEvent.click(plus('Later'));
    expect(document.activeElement).toBe(later);
    expect(later.value).toBe('Half typed');
    fireEvent.click(plus('Next'));
    const next = field('New card for Next');
    expect(document.activeElement).toBe(next);
    // Shift+Enter is Enter, and an input method's Enter adds nothing.
    fireEvent.change(next, { target: { value: 'Call the vendor' } });
    fireEvent.keyDown(next, { key: 'Enter', isComposing: true });
    expect(next.value).toBe('Call the vendor');
    fireEvent.keyDown(next, { key: 'Enter', shiftKey: true });
    await settle();
    expect(added().map((c) => [c.title, c.categoryUid, c.lane, c.before])).toEqual([
      ['Look into the export', null, 'later', 'later0000001'],
      ['Call the vendor', null, 'next', null],
    ]);
    expect(titlesIn('Later')).toEqual(['Look into the export', 'Write a KB']);
    // Plan B sits in Next at its place, not moved.
    expect(titlesIn('Next')).toEqual(['Follow up', 'Plan B', 'Call the vendor']);
    // Later's box, left with text, stays open.
    expect(field('New card for Later').value).toBe('Half typed');
  });

  it('closes a box on Escape, dropping its text, or on an empty Enter, with the focus back on its +, and on leaving it only while empty', async () => {
    await renderBoard();
    fireEvent.click(plus('Later'));
    fireEvent.change(field('New card for Later'), { target: { value: 'Half a thought' } });
    // An input method's Escape is the input method's.
    fireEvent.keyDown(field('New card for Later'), { key: 'Escape', isComposing: true });
    expect(isOpen('New card for Later')).toBe(true);
    fireEvent.keyDown(field('New card for Later'), { key: 'Escape' });
    expect(isOpen('New card for Later')).toBe(false);
    expect(document.activeElement).toBe(plus('Later'));
    fireEvent.click(plus('Later'));
    expect(field('New card for Later').value).toBe('');
    fireEvent.change(field('New card for Later'), { target: { value: '   ' } });
    fireEvent.keyDown(field('New card for Later'), { key: 'Enter' });
    expect(isOpen('New card for Later')).toBe(false);
    expect(document.activeElement).toBe(plus('Later'));

    // Left with text it stays open; left empty it closes, and the focus stays where it went.
    fireEvent.click(plus('Next'));
    const next = field('New card for Next');
    fireEvent.change(next, { target: { value: 'Keep me' } });
    act(() => next.blur());
    expect(field('New card for Next').value).toBe('Keep me');
    fireEvent.change(next, { target: { value: '' } });
    act(() => next.focus());
    // Switching to another app closes nothing.
    const away = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    act(() => next.blur());
    expect(isOpen('New card for Next')).toBe(true);
    away.mockRestore();
    act(() => next.focus());
    openCard('Write a KB');
    const title = screen.getByRole('textbox', { name: 'Title' });
    act(() => title.focus());
    expect(isOpen('New card for Next')).toBe(false);
    expect(document.activeElement).toBe(title);
    await settle();
    expect(api.addItem).not.toHaveBeenCalled();
  });

  it('shows the column whose + is pressed, as a phone shows one at a time', async () => {
    await renderBoard();
    expect(shownColumns()).toEqual(['In progress']);
    fireEvent.click(plus('Later'));
    expect(shownColumns()).toEqual(['Later']);
    expect(document.activeElement).toBe(field('New card for Later'));
  });

  it("opens Later's box on N, showing Later on a phone, with N named on Later's + while it would open", async () => {
    await renderBoard();
    expect(plus('Later').getAttribute('aria-keyshortcuts')).toBe('N');
    expect(plus('Next').hasAttribute('aria-keyshortcuts')).toBe(false);
    expect(pressKey('n')).toBe(false);
    expect(shownColumns()).toEqual(['Later']);
    expect(document.activeElement).toBe(field('New card for Later'));
    cleanup();
    onServer = makeBoard(...fullBoard());
    await renderBoard();
    expect(plus('Later').hasAttribute('aria-keyshortcuts')).toBe(false);
    expect(pressKey('n')).toBe(true);
    expect(isOpen('New card for Later')).toBe(false);
  });

  // With today's list unread there is no Later's + to stand for, so N mustn't leave its box to open once it is.
  it("leaves N alone while today's list could not be read", async () => {
    vi.mocked(api.getDay).mockRejectedValueOnce(new Error('offline'));
    await renderBoard();
    expect(pressKey('n')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();
    expect(isOpen('New card for Later')).toBe(false);
  });

  it("shuts Later's and Next's + at the cap and In progress's on a full list, saying why under each, where Tab still reaches it", async () => {
    onServer = makeBoard(...fullBoard());
    await renderBoard();
    const why = (add: HTMLElement) => document.getElementById(add.getAttribute('aria-describedby')!)?.textContent;
    for (const name of ['Later', 'Next']) {
      expect(plus(name).getAttribute('aria-disabled')).toBe('true');
      expect(why(plus(name))).toBe(BOARD.full);
      expect((plus(name) as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(plus(name));
    }
    expect(screen.queryByRole('textbox')).toBeNull();
    // A shut + doesn't show its column either.
    expect(shownColumns()).toEqual(['In progress']);
    // A task typed in In progress has no lane: the cap doesn't count it.
    expect(plus('In progress').getAttribute('aria-disabled')).toBeNull();
    expect(plus('In progress').getAttribute('aria-describedby')).toBeNull();
    fireEvent.click(plus('In progress'));
    enter(field('New priority for today'), 'Call the vendor');
    await settle();
    expect(putLists()).toEqual([{ date: WED, texts: ['Report', 'Email', 'Call the vendor'] }]);

    cleanup();
    onServer = makeBoard();
    lists[WED] = Array.from({ length: MAX_PRIORITIES }, (_, i) => row(i + 1, `Task ${i + 1}`));
    await renderBoard();
    expect(plus('In progress').getAttribute('aria-disabled')).toBe('true');
    expect(why(plus('In progress'))).toBe(ADD_PRIORITY_FAILED.full);
    fireEvent.click(plus('In progress'));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(plus('Later').getAttribute('aria-disabled')).toBeNull();
  });

  it("closes a box as its + shuts, with the focus on the +, so it doesn't open again by itself when the + opens", async () => {
    vi.stubGlobal('confirm', () => true);
    onServer = makeBoard(...fullBoard().slice(1));
    await renderBoard();
    fireEvent.click(plus('Later'));
    enter(field('New card for Later'), 'One more');
    expect(plus('Later').getAttribute('aria-disabled')).toBe('true');
    expect(isOpen('New card for Later')).toBe(false);
    expect(document.activeElement).toBe(plus('Later'));
    await settle();
    openCard('One more');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await settle();
    expect(plus('Later').getAttribute('aria-disabled')).toBeNull();
    expect(isOpen('New card for Later')).toBe(false);
  });

  it("adds a task to today's list from In progress's box on the board's queue, after a board write still out, and keeps the box", async () => {
    const placed = deferredAnswer<BoardData>();
    vi.mocked(api.editItem).mockReturnValueOnce(placed.promise);
    await renderBoard();
    openCard('Report');
    moveTo('later');
    fireEvent.click(plus('In progress'));
    const box = field('New priority for today');
    expect(box.placeholder).toBe('New priority');
    enter(box, 'Call the vendor');
    // The box stays open for the next one, with the focus.
    expect(box.value).toBe('');
    expect(document.activeElement).toBe(box);
    await settle();
    expect(api.putPriorities).not.toHaveBeenCalled();
    // Left empty, it closes; the row that lands later doesn't take the focus (only Add anyway moves it).
    act(() => box.blur());
    expect(isOpen('New priority for today')).toBe(false);
    placed.resolve((onServer = withItemPatch(onServer, REPORT, { lane: 'later', before: 'later0000001' })));
    await settle();
    // The park's list, then the new row in the row it freed: a task of its own, in no lane.
    expect(putLists()).toEqual([
      { date: WED, texts: ['', 'Email', ''] },
      { date: WED, texts: ['Call the vendor', 'Email', ''] },
    ]);
    expect(lists[WED]![0]).toMatchObject({ text: 'Call the vendor', done: false, recurring: false, categoryUid: null });
    expect(lists[WED]![0]!.uid).toMatch(/^[0-9a-f]{12}$/);
    expect(api.addItem).not.toHaveBeenCalled();
    expect(titlesIn('In progress')).toEqual(['Call the vendor']);
    expect(document.activeElement).toBe(document.body);
  });

  it("counts the rows still waiting on the board's queue toward the nudge, as the sheet counts its draft", async () => {
    lists[WED] = [row(1, 'Report'), row(2, 'Email')];
    // A lane's PATCH still out holds the board's queue, and the rows typed after it with it.
    const placed = deferredAnswer<BoardData>();
    vi.mocked(api.editItem).mockReturnValueOnce(placed.promise);
    await renderBoard();
    openCard('Write a KB');
    moveTo('next');
    fireEvent.click(plus('In progress'));
    const box = field('New priority for today');
    enter(box, 'Call the vendor');
    expect(notice().textContent).toBe('');
    enter(box, 'Book the room');
    expect(PRIORITY_WARNINGS.fresh).toContain(within(notice()).getByText(/./, { selector: 'span:not(.notice-actions)' }).textContent);
    expect(box.value).toBe('Book the room');
    placed.resolve((onServer = withItemPatch(onServer, 'later0000001', { lane: 'next', before: null })));
    await settle();
    expect(putLists()).toEqual([{ date: WED, texts: ['Report', 'Email', 'Call the vendor'] }]);
  });

  it('stops counting a row toward the nudge once its save fails', async () => {
    lists[WED] = [row(1, 'Report'), row(2, 'Email')];
    vi.mocked(api.putPriorities).mockRejectedValueOnce(new Error('offline'));
    await renderBoard();
    fireEvent.click(plus('In progress'));
    const box = field('New priority for today');
    enter(box, 'Call the vendor');
    expect(notice().textContent).toBe('');
    await settle();
    // Row 3 is free again.
    enter(box, 'Book the room');
    expect(notice().textContent).toBe('');
  });

  it("asks first from In progress's box past the nudge: Keep it short leaves the text in the box, Add anyway adds it, closes the box and focuses the new row", async () => {
    lists[WED] = [row(1, 'Report'), row(2, 'Email'), row(3, 'Invoices')];
    await renderBoard();
    fireEvent.click(plus('In progress'));
    const box = field('New priority for today');
    enter(box, 'Call the vendor');
    expect(PRIORITY_WARNINGS.fresh).toContain(within(notice()).getByText(/./, { selector: 'span:not(.notice-actions)' }).textContent);
    expect(document.activeElement).toBe(within(notice()).getByRole('button', { name: WARNING_ACTIONS.fresh.add }));
    expect(box.value).toBe('Call the vendor');
    // On a phone the notice stays up while another column shows: its answer shows In progress again.
    const show = (name: string) => fireEvent.click(within(screen.getByRole('group', { name: 'Board column' })).getByRole('button', { name }));
    show('Next');
    fireEvent.click(within(notice()).getByRole('button', { name: WARNING_ACTIONS.fresh.keep }));
    expect(within(notice()).queryByRole('button')).toBeNull();
    expect(shownColumns()).toEqual(['In progress']);
    expect(document.activeElement).toBe(box);
    expect(box.value).toBe('Call the vendor');
    await settle();
    expect(api.putPriorities).not.toHaveBeenCalled();

    fireEvent.keyDown(box, { key: 'Enter' });
    show('Later');
    fireEvent.click(within(notice()).getByRole('button', { name: WARNING_ACTIONS.fresh.add }));
    expect(isOpen('New priority for today')).toBe(false);
    expect(shownColumns()).toEqual(['In progress']);
    await settle();
    expect(putLists()).toEqual([{ date: WED, texts: ['Report', 'Email', 'Invoices', 'Call the vendor'] }]);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Call the vendor' }));
  });

  // happy-dom never turns a key into a click, so this checks what the browser obeys: the default prevented.
  it("doesn't take a key still held from the press that raised the nudge as its answer", async () => {
    lists[WED] = [row(1, 'Report'), row(2, 'Email'), row(3, 'Invoices')];
    await renderBoard();
    fireEvent.click(plus('In progress'));
    enter(field('New priority for today'), 'Call the vendor');
    const add = within(notice()).getByRole('button', { name: WARNING_ACTIONS.fresh.add });
    expect(document.activeElement).toBe(add);
    expect(fireEvent.keyDown(add, { key: 'Enter', repeat: true })).toBe(false);
    expect(fireEvent.keyDown(add, { key: ' ', repeat: true })).toBe(false);
    expect(fireEvent.keyDown(add, { key: 'Enter' })).toBe(true);
  });

  it("drops the question In progress's box held when its text changes, and asks again on Enter with the new text", async () => {
    lists[WED] = [row(1, 'Report'), row(2, 'Email'), row(3, 'Invoices')];
    await renderBoard();
    fireEvent.click(plus('In progress'));
    const box = field('New priority for today');
    enter(box, 'Call bank');
    // Typing in another column's box leaves it.
    fireEvent.click(plus('Later'));
    fireEvent.change(field('New card for Later'), { target: { value: 'Half typed' } });
    expect(within(notice()).getAllByRole('button')).toHaveLength(2);
    fireEvent.change(box, { target: { value: 'Call the bank about fees' } });
    expect(notice().textContent).toBe('');
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.click(within(notice()).getByRole('button', { name: WARNING_ACTIONS.fresh.add }));
    await settle();
    expect(putLists()).toEqual([{ date: WED, texts: ['Report', 'Email', 'Invoices', 'Call the bank about fees'] }]);
  });

  it("drops the row In progress's box held for the nudge when the box closes", async () => {
    lists[WED] = [row(1, 'Report'), row(2, 'Email'), row(3, 'Invoices')];
    await renderBoard();
    fireEvent.click(plus('In progress'));
    enter(field('New priority for today'), 'Call the vendor');
    expect(within(notice()).getAllByRole('button')).toHaveLength(2);
    fireEvent.keyDown(field('New priority for today'), { key: 'Escape' });
    expect(notice().textContent).toBe('');
    expect(document.activeElement).toBe(plus('In progress'));
    await settle();
    expect(api.putPriorities).not.toHaveBeenCalled();
    // A pull's question stays when the box closes.
    fireEvent.click(plus('In progress'));
    fireEvent.change(field('New priority for today'), { target: { value: 'Half typed' } });
    openCard('Follow up');
    moveTo('progress');
    fireEvent.keyDown(field('New priority for today'), { key: 'Escape' });
    expect(within(notice()).getByRole('button', { name: WARNING_ACTIONS.fresh.add })).toBeTruthy();
  });

  it('clears an earlier notice when a row goes in from In progress below the nudge', async () => {
    await renderBoard();
    openCard('Email');
    moveTo('next');
    expect(notice().textContent).toContain(DONE_STAYS.body);
    fireEvent.click(plus('In progress'));
    enter(field('New priority for today'), 'Call the vendor');
    expect(notice().textContent).toBe('');
  });
});

describe("a card's note", () => {
  const box = (title: string) => screen.queryByRole('textbox', { name: `Note for ${title}` }) as HTMLTextAreaElement | null;
  const withNote = () => ({ ...onServer, cards: onServer.cards.map((c) => (c.uid === 'later0000001' ? { ...c, note: 'From ticket 4821.' } : c)) });

  it('marks a card with a note on its meta line, and no other, with no note button on any card', async () => {
    onServer = withNote();
    await renderBoard();
    const marks = screen.getAllByRole('img', { name: 'Has a note' });
    expect(marks).toHaveLength(1);
    expect(marks[0]!.closest('.board-card-meta')?.closest('.board-card')?.querySelector('.board-card-title')?.textContent).toBe('Write a KB');
    expect(screen.queryByRole('button', { name: /note/i })).toBeNull();
  });

  it("holds the note in the card's dialog, where Escape closes the dialog with the note saved and the focus on the card", async () => {
    onServer = withNote();
    await renderBoard();
    openCard('Write a KB');
    expect(box('Write a KB')!.value).toBe('From ticket 4821.');
    act(() => box('Write a KB')!.focus());
    fireEvent.change(box('Write a KB')!, { target: { value: 'From ticket 4821. Ask Kim.' } });
    fireEvent.keyDown(box('Write a KB')!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Write a KB' }));
    // Closing it saved it, without waiting.
    await settle();
    expect(api.editItem).toHaveBeenCalledExactlyOnceWith('later0000001', { note: 'From ticket 4821. Ask Kim.' });
    openCard('Write a KB');
    expect(box('Write a KB')!.value).toBe('From ticket 4821. Ask Kim.');
  });

  it("saves a card's note by a PATCH 800 ms after the last key and when the box is left, and today's row's through the row", async () => {
    await renderBoard();
    openCard('Write a KB');
    fireEvent.change(box('Write a KB')!, { target: { value: 'Ask Kim' } });
    await settle(799);
    expect(api.editItem).not.toHaveBeenCalled();
    await settle(1);
    expect(api.editItem).toHaveBeenCalledExactlyOnceWith('later0000001', { note: 'Ask Kim' });
    fireEvent.change(box('Write a KB')!, { target: { value: 'Ask Kim first' } });
    fireEvent.blur(box('Write a KB')!);
    await settle();
    expect(vi.mocked(api.editItem).mock.lastCall).toEqual(['later0000001', { note: 'Ask Kim first' }]);
    expect(within(column('Later')).getByRole('img', { name: 'Has a note' })).toBeTruthy();

    closeCard();
    openCard('Report');
    fireEvent.change(box('Report')!, { target: { value: 'Numbers from Kim' } });
    fireEvent.blur(box('Report')!);
    await settle();
    expect(lists[WED]![0]).toMatchObject({ text: 'Report', note: 'Numbers from Kim' });
    expect(api.editItem).toHaveBeenCalledTimes(2);
  });

  it('keeps a note whose save failed in its box, with the banner, and sends it again on the next edit', async () => {
    await renderBoard();
    vi.mocked(api.editItem).mockRejectedValueOnce(new Error('offline'));
    openCard('Write a KB');
    fireEvent.change(box('Write a KB')!, { target: { value: 'Ask Kim' } });
    fireEvent.blur(box('Write a KB')!);
    await settle();
    expect(warnSaveFailed).toHaveBeenCalledOnce();
    expect(box('Write a KB')!.value).toBe('Ask Kim');
    fireEvent.change(box('Write a KB')!, { target: { value: 'Ask Kim today' } });
    await settle(800);
    expect(vi.mocked(api.editItem).mock.lastCall).toEqual(['later0000001', { note: 'Ask Kim today' }]);
    expect(onServer.cards.find((c) => c.uid === 'later0000001')!.note).toBe('Ask Kim today');
  });

  it('shows a note whose save failed as its dialog closed when the dialog opens again, and sends it again as that one closes', async () => {
    await renderBoard();
    vi.mocked(api.editItem).mockRejectedValueOnce(new Error('offline'));
    openCard('Write a KB');
    act(() => box('Write a KB')!.focus());
    fireEvent.change(box('Write a KB')!, { target: { value: 'Ask Kim' } });
    closeCard();
    await settle();
    expect(warnSaveFailed).toHaveBeenCalledOnce();
    expect(onServer.cards.find((c) => c.uid === 'later0000001')!.note).toBe('');
    openCard('Write a KB');
    expect(box('Write a KB')!.value).toBe('Ask Kim');
    closeCard();
    await settle();
    expect(vi.mocked(api.editItem).mock.lastCall).toEqual(['later0000001', { note: 'Ask Kim' }]);
    expect(onServer.cards.find((c) => c.uid === 'later0000001')!.note).toBe('Ask Kim');
    // Saved, it is kept no more: another device clearing the note clears the box.
    onServer = withItemPatch(onServer, 'later0000001', { note: '' });
    changedElsewhere();
    await settle();
    openCard('Write a KB');
    expect(box('Write a KB')!.value).toBe('');
  });

  it("drops a note whose save failed once another device changes the task's note, for good", async () => {
    await renderBoard();
    vi.mocked(api.editItem).mockRejectedValueOnce(new Error('offline'));
    openCard('Write a KB');
    act(() => box('Write a KB')!.focus());
    fireEvent.change(box('Write a KB')!, { target: { value: 'Ask Kim' } });
    closeCard();
    await settle();
    onServer = withItemPatch(onServer, 'later0000001', { note: 'From Kim' });
    changedElsewhere();
    await settle();
    // Back to the note it was typed over, the dropped text doesn't come back.
    onServer = withItemPatch(onServer, 'later0000001', { note: '' });
    changedElsewhere();
    await settle();
    openCard('Write a KB');
    expect(box('Write a KB')!.value).toBe('');
    closeCard();
    await settle();
    expect(api.editItem).toHaveBeenCalledTimes(1);
  });

  it('shows a note in a dialog opened again while the save from its close is out, once that save fails', async () => {
    const answer = deferredAnswer<BoardData>();
    vi.mocked(api.editItem).mockReturnValueOnce(answer.promise);
    await renderBoard();
    openCard('Write a KB');
    act(() => box('Write a KB')!.focus());
    fireEvent.change(box('Write a KB')!, { target: { value: 'Ask Kim' } });
    closeCard();
    openCard('Write a KB');
    expect(box('Write a KB')!.value).toBe('Ask Kim');
    answer.reject(new Error('offline'));
    await settle();
    expect(warnSaveFailed).toHaveBeenCalledOnce();
    expect(box('Write a KB')!.value).toBe('Ask Kim');
    closeCard();
    await settle();
    expect(vi.mocked(api.editItem).mock.lastCall).toEqual(['later0000001', { note: 'Ask Kim' }]);
    expect(onServer.cards.find((c) => c.uid === 'later0000001')!.note).toBe('Ask Kim');
  });

  it("shows an earlier day's row of a stopped recurring priority's note as text in its dialog, and no note where there is none", async () => {
    serveRange([
      makeDay(TUE, { priorities: [row(1, 'Tuesday row', { uid: 'rec000000009', recurring: true, done: true, note: 'Acme first' })] }),
      makeDay(MON, { priorities: [row(1, 'Monday row', { uid: 'rec000000008', recurring: true, done: true })] }),
    ]);
    await renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Earlier this week · 3' }));
    openCard('Tuesday row');
    expect(box('Tuesday row')).toBeNull();
    expect(dialog().querySelector('.note-text')?.textContent).toBe('Acme first');
    closeCard();
    openCard('Monday row');
    expect(dialog().querySelector('.note-field')).toBeNull();
  });
});

describe('repeating', () => {
  const QUEUE = makeRecurring('rec000000001', 'Monitor the queue');
  const FOLLOW = makeRecurring('rec000000002', 'Follow-ups', { weekdays: [1, 3, 5] });
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
    expect(titlesIn('In progress')).toEqual(['Report', 'Monitor the queue']);
    expect(column('In progress').querySelector('.board-card-meta')?.textContent).toBe('');
  });

  it('says Later has nothing parked only when Repeats is empty too', async () => {
    onServer = { ...makeBoard(), recurring: [FOLLOW] };
    await renderBoard();
    expect(titlesIn('Later')).toEqual(['Follow-ups']);
    expect(within(column('Later')).queryByText('Nothing parked.')).toBeNull();
    cleanup();
    onServer = makeBoard();
    await renderBoard();
    expect(within(column('Later')).getByText('Nothing parked.')).toBeTruthy();
    expect(within(column('Later')).queryByRole('heading', { name: 'Repeats' })).toBeNull();
  });

  it('makes a card repeat on the first day pressed, once confirmed, keeping its dialog open on that day, with Stop repeating in place of Delete', async () => {
    await renderBoard();
    openCard('Write a KB');
    expect(
      within(repeatGroup()!)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
    expect(pressed()).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Stop repeating' })).toBeNull();
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
    expect(screen.getByRole('button', { name: 'Stop repeating' })).toBeTruthy();
    expect(moveOptions()).toEqual(['In progress', 'Done']);
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
    expect(screen.getByRole('button', { name: 'Remove from today' })).toBeTruthy();
    await settle();
    expect(api.editItem).toHaveBeenCalledExactlyOnceWith(REPORT, { weekday: { day: 5, on: true } });
    expect(api.getDay).toHaveBeenCalledWith(WED);
    expect(dialog().getAttribute('aria-label')).toBe('Report');
    expect(pressed()).toEqual(['Friday']);
    expect(titlesIn('In progress')).toEqual(['Report']);
    expect(within(column('In progress')).getByRole('img', { name: 'Repeats' })).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: 'Stop repeating' }));
    expect(confirm).toHaveBeenCalledExactlyOnceWith(CONFIRM.deleteRecurring('Monitor the queue'));
    expect(dialog()).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop repeating' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Stop repeating' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Monitor the queue' }));
    await settle();
    expect(api.deleteItem).toHaveBeenCalledExactlyOnceWith(QUEUE.uid);
    expect(titlesIn('In progress')).toEqual(['Monitor the queue', 'Report']);
    openCard('Monitor the queue');
    expect(repeatGroup()).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove from today' })).toBeTruthy();
  });

  it("offers no Repeat row where the server can't change the task: an earlier day's tick of a stopped routine, an archived task's row", async () => {
    lists[WED] = [row(1, 'Report', { archived: true })];
    await renderBoard();
    openCard('Report');
    expect(repeatGroup()).toBeNull();
    closeCard();
    fireEvent.click(screen.getByRole('button', { name: 'Earlier this week · 2' }));
    openCard('Tuesday row');
    expect(repeatGroup()).toBeNull();
  });

  it("puts a card of Repeats on today's list with Move to, and ticked with Done", async () => {
    const saved = deferredAnswer<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(saved.promise);
    await renderBoard();
    openCard('Follow-ups');
    expect(moveOptions()).toEqual(['In progress', 'Done']);
    moveTo('progress');
    // On its way to In progress, it shows there without the days Repeats lists.
    expect(titlesIn('In progress')).toEqual(['Report', 'Follow-ups']);
    expect(within(column('In progress')).queryByText('Mon, Wed, Fri')).toBeNull();
    await settle();
    saved.resolve({ priorities: (lists[WED] = vi.mocked(api.putPriorities).mock.lastCall![1]) });
    await settle();
    expect(putLists()).toEqual([{ date: WED, texts: ['Report', 'Email', 'Follow-ups'] }]);
    expect(lists[WED]![2]).toMatchObject({ uid: FOLLOW.uid, recurring: true, done: false });
    expect(titlesIn('In progress')).toEqual(['Report', 'Follow-ups']);
    expect(titlesIn('Later')).toEqual(['Write a KB', 'Monitor the queue']);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Follow-ups' }));
    openCard('Monitor the queue');
    moveTo('done');
    expect(unlockAudio).toHaveBeenCalledOnce();
    await settle();
    expect(lists[WED]![3]).toMatchObject({ uid: QUEUE.uid, recurring: true, done: true });
    expect(titlesIn('Done')).toEqual(['Email', 'Monitor the queue', 'Earlier this week · 2']);
  });
});

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
    expect(titlesIn('In progress')).toEqual(['Report', 'Follow up']);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Follow up' }));
  });

  it("starts on a card of Later's Repeats once its pull puts the recurring priority on today's list", async () => {
    onServer = { ...onServer, recurring: [makeRecurring('rec000000001', 'Monitor the queue')] };
    await renderBoard();
    openCard('Monitor the queue');
    startFor(25);
    expect(start).toHaveBeenCalledExactlyOnceWith(WED, 25 * 60, 'Monitor the queue', expect.any(Promise));
    await settle();
    expect(putLists()).toEqual([{ date: WED, texts: ['Report', 'Email', 'Monitor the queue'] }]);
    expect(lists[WED]![2]).toMatchObject({ uid: 'rec000000001', recurring: true });
    await expect(startedOn()).resolves.toBe('rec000000001');
    expect(titlesIn('In progress')).toEqual(['Report', 'Monitor the queue']);
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
    lists[WED] = [row(1, 'Report'), row(2, 'Email', { done: true }), row(3, 'Monitor the queue', { uid: 'rec000000001', recurring: true })];
    const placed = deferredAnswer<BoardData>();
    vi.mocked(api.editItem).mockReturnValueOnce(placed.promise);
    await renderBoard();
    for (const title of ['Monitor the queue', 'Write a KB', 'Plan B']) {
      openCard(title);
      expect(startGroup()).not.toBeNull();
      closeCard();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Earlier this week · 2' }));
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

describe('dragging', () => {
  // happy-dom lays nothing out, so this is a desktop window's: the four columns side by side,
  // 280 px wide from x 20, with cards 40 px tall and 50 px apart from y 260, and the copy under
  // the pointer where dnd-kit puts it.
  beforeEach(() => {
    const box = (left: number, top: number, width: number, height: number) => new DOMRect(left, top, width, height);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const cols = [...document.querySelectorAll('.board-col')];
      const col = this.closest('.board-col');
      if (this.classList.contains('board-col')) return box(20 + cols.indexOf(this) * 300, 200, 280, 600);
      if (col && this.matches('li.board-card'))
        return box(32 + cols.indexOf(col) * 300, 260 + [...col.querySelectorAll('li.board-card')].indexOf(this) * 50, 256, 40);
      // The copy fills dnd-kit's fixed frame, which is where the item was, moved by a translate.
      const frame = [this, this.parentElement].find((el) => el?.style.position === 'fixed');
      if (frame) {
        const [, x = '0', y = '0'] = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px/.exec(frame.style.transform) ?? [];
        const px = (v: string) => parseFloat(v) || 0;
        return box(px(frame.style.left) + px(x), px(frame.style.top) + px(y), px(frame.style.width), px(frame.style.height));
      }
      return box(0, 0, 0, 0);
    });
  });

  /** An item's card: its button, which a drag picks up. */
  const card = (title: string) => screen.getByRole('button', { name: title });
  /** What dnd-kit's live region last said. */
  const said = () => document.querySelector('[id^="DndLiveRegion"]')!.textContent;
  async function press(code: string, target: Element | Document = document) {
    fireEvent.keyDown(target, { code });
    await settle();
  }
  /** Space on the item's card, as a keyboard user picks it up. */
  async function pickUp(title: string) {
    card(title).focus();
    await press('Space', card(title));
  }

  it('moves a card into the next lane by keyboard, before the card it lands on, saying what happens and keeping the focus on it', async () => {
    await renderBoard();
    await pickUp('Write a KB');
    expect(said()).toBe(BOARD_DRAG.pickedUp('Write a KB', 'Later'));
    await press('ArrowRight');
    expect(said()).toBe(BOARD_DRAG.overBefore('Write a KB', 'Next', 'Follow up'));
    // It shows where it would land, in a column marked as the one it is over.
    expect(titlesIn('Next')).toEqual(['Write a KB', 'Follow up', 'Plan B']);
    expect(column('Next').hasAttribute('data-over')).toBe(true);
    await press('Space');
    expect(api.editItem).toHaveBeenCalledExactlyOnceWith('later0000001', { lane: 'next', before: 'next00000001' });
    expect(said()).toBe(BOARD_DRAG.moved('Write a KB', 'Next'));
    expect(titlesIn('Next')).toEqual(['Write a KB', 'Follow up', 'Plan B']);
    expect(column('Next').hasAttribute('data-over')).toBe(false);
    expect(document.activeElement).toBe(card('Write a KB'));
  });

  it('leaves Enter to open the card, picking nothing up, and a repeated Enter or the keyup of Space opens nothing', async () => {
    await renderBoard();
    card('Write a KB').focus();
    await press('Enter', card('Write a KB'));
    expect(said()).toBe('');
    // happy-dom never turns a key into a click, so these check what the browser obeys: the default prevented.
    expect(fireEvent.keyDown(card('Write a KB'), { key: 'Enter' })).toBe(true);
    expect(fireEvent.keyDown(card('Write a KB'), { key: 'Enter', repeat: true })).toBe(false);
    expect(fireEvent.keyUp(card('Write a KB'), { key: ' ' })).toBe(false);
    expect(fireEvent.keyUp(card('Write a KB'), { key: 'Enter' })).toBe(true);
  });

  it('sorts a card within its lane by keyboard', async () => {
    onServer = makeBoard(...onServer.cards, makeCard('later0000002', 'Call the vendor', { position: 2 }));
    await renderBoard();
    await pickUp('Write a KB');
    await press('ArrowDown');
    expect(said()).toBe(BOARD_DRAG.overEnd('Write a KB', 'Later'));
    await press('Space');
    expect(api.editItem).toHaveBeenCalledExactlyOnceWith('later0000001', { before: null });
    expect(titlesIn('Later')).toEqual(['Call the vendor', 'Write a KB']);
  });

  it("pulls a task onto today's list by keyboard: Next, then In progress", async () => {
    await renderBoard();
    await pickUp('Write a KB');
    await press('ArrowRight');
    await press('ArrowRight');
    expect(said()).toBe(BOARD_DRAG.over('Write a KB', 'In progress'));
    expect(titlesIn('In progress')).toEqual(['Report', 'Write a KB']);
    await press('Space');
    expect(said()).toBe(BOARD_DRAG.moved('Write a KB', 'In progress'));
    expect(putLists()).toEqual([{ date: WED, texts: ['Report', 'Email', 'Write a KB'] }]);
    expect(titlesIn('In progress')).toEqual(['Report', 'Write a KB']);
    // A row of today's now: the focus finds its card there.
    expect(document.activeElement).toBe(card('Write a KB'));
  });

  it('keeps a done row done when it is dropped on Next, and Add a new card puts one where it was dropped', async () => {
    await renderBoard();
    await pickUp('Email');
    expect(said()).toBe(BOARD_DRAG.pickedUp('Email', 'Done'));
    // In progress and Done don't sort: up and down go nowhere.
    await press('ArrowUp');
    expect(said()).toBe(BOARD_DRAG.pickedUp('Email', 'Done'));
    await press('ArrowLeft');
    await press('ArrowLeft');
    expect(titlesIn('Next')).toEqual(['Email', 'Follow up', 'Plan B']);
    await press('Space');
    expect(said()).toBe(DONE_STAYS.announce('Email', 'Next'));
    expect(titlesIn('Done')).toEqual(['Email', 'Earlier this week · 2']);
    expect(document.activeElement).toBe(within(notice()).getByRole('button', { name: DONE_STAYS.add('Next') }));
    fireEvent.click(screen.getByRole('button', { name: DONE_STAYS.add('Next') }));
    await settle();
    expect(added().map((c) => [c.title, c.lane, c.before])).toEqual([['Email', 'next', 'next00000001']]);
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(titlesIn('Next')).toEqual(['Email', 'Follow up', 'Plan B']);
  });

  it('says when the item is back over where it started, though not as it is picked up', async () => {
    await renderBoard();
    await pickUp('Report');
    expect(said()).toBe(BOARD_DRAG.pickedUp('Report', 'In progress'));
    await press('ArrowRight');
    expect(said()).toBe(BOARD_DRAG.over('Report', 'Done'));
    await press('ArrowLeft');
    expect(said()).toBe(BOARD_DRAG.overStart('Report', 'In progress'));
    await press('Escape');
  });

  it('ignores keys while an item is dragged by keyboard', async () => {
    await renderBoard();
    await pickUp('Write a KB');
    expect(pressKey('n')).toBe(true);
    expect(isOpen('New card for Later')).toBe(false);
    await press('Escape');
    expect(pressKey('n')).toBe(false);
    expect(isOpen('New card for Later')).toBe(true);
  });

  it('puts the item back on Escape, sending nothing', async () => {
    await renderBoard();
    await pickUp('Write a KB');
    await press('ArrowRight');
    await press('Escape');
    expect(said()).toBe(BOARD_DRAG.cancelled('Write a KB', 'Later'));
    expect(titlesIn('Later')).toEqual(['Write a KB']);
    expect(titlesIn('Next')).toEqual(['Follow up', 'Plan B']);
    expect(document.activeElement).toBe(card('Write a KB'));
    await settle();
    expect(api.editItem).not.toHaveBeenCalled();
  });

  it('says a drop where it started changed nothing, and sends nothing', async () => {
    await renderBoard();
    await pickUp('Report');
    await press('Space');
    expect(said()).toBe(BOARD_DRAG.stays('Report', 'In progress'));
    expect(api.putPriorities).not.toHaveBeenCalled();
  });

  it('ticks a row dropped on Done with the mouse, unlocking the sound', async () => {
    await renderBoard();
    fireEvent.mouseDown(card('Report'), { button: 0, clientX: 640, clientY: 270 });
    fireEvent.mouseMove(document, { clientX: 700, clientY: 280 });
    await settle();
    fireEvent.mouseMove(document, { clientX: 960, clientY: 400 });
    await settle();
    expect(said()).toBe(BOARD_DRAG.over('Report', 'Done'));
    fireEvent.mouseUp(document, { clientX: 960, clientY: 400 });
    expect(unlockAudio).toHaveBeenCalledTimes(1);
    // dnd-kit keeps a click guard on the document for 50 ms after a pointer drag, which would
    // swallow the next test's clicks.
    await settle(50);
    expect(putLists()).toEqual([{ date: WED, texts: ['Report', 'Email', ''] }]);
    expect(lists[WED]![0]!.done).toBe(true);
  });

  it('opens a card on a press the mouse moved less than 6 px, picking nothing up', async () => {
    await renderBoard();
    fireEvent.mouseDown(card('Write a KB'), { button: 0, clientX: 100, clientY: 270 });
    fireEvent.mouseMove(document, { clientX: 104, clientY: 272 });
    fireEvent.mouseUp(document, { clientX: 104, clientY: 272 });
    fireEvent.click(card('Write a KB'));
    expect(dialog().getAttribute('aria-label')).toBe('Write a KB');
    expect(said()).toBe('');
  });

  it('picks a card up on a finger held still, and leaves a finger that moves first to scroll', async () => {
    await renderBoard();
    const touch = (x: number, y: number) => ({ touches: [{ clientX: x, clientY: y }], changedTouches: [{ clientX: x, clientY: y }] });
    // dnd-kit follows a touch on the card it started on, or on the document where an element isn't
    // an EventTarget (happy-dom's).
    fireEvent.touchStart(card('Write a KB'), touch(100, 270));
    fireEvent.touchMove(document, touch(100, 290));
    await settle(250);
    expect(said()).toBe('');
    fireEvent.touchEnd(document, touch(100, 290));

    fireEvent.touchStart(card('Write a KB'), touch(100, 270));
    await settle(250);
    expect(said()).toBe(BOARD_DRAG.pickedUp('Write a KB', 'Later'));
    fireEvent.touchMove(document, touch(150, 280));
    await settle();
    fireEvent.touchMove(document, touch(400, 280));
    await settle();
    expect(said()).toBe(BOARD_DRAG.overBefore('Write a KB', 'Next', 'Follow up'));
    fireEvent.touchEnd(document, touch(400, 280));
    await settle(50);
    expect(api.editItem).toHaveBeenCalledExactlyOnceWith('later0000001', { lane: 'next', before: 'next00000001' });
  });

  it('holds a pull onto a full list with the nudge, as Move to does', async () => {
    lists[WED] = [row(1, 'Report'), row(2, 'Email'), row(3, 'Invoices')];
    await renderBoard();
    await pickUp('Follow up');
    await press('ArrowRight');
    await press('Space');
    expect(PRIORITY_WARNINGS.fresh).toContain(said());
    const add = within(notice()).getByRole('button', { name: WARNING_ACTIONS.fresh.add });
    expect(document.activeElement).toBe(add);
    await settle();
    expect(api.putPriorities).not.toHaveBeenCalled();
    // Add anyway goes with the notice: the focus goes to the card of the task's row.
    fireEvent.click(add);
    await settle();
    expect(putLists()[0]!.texts).toEqual(['Report', 'Email', 'Invoices', 'Follow up']);
    expect(document.activeElement).toBe(card('Follow up'));
  });

  it("doesn't pick up an item whose move is on its way until the move lands", async () => {
    const placed = deferredAnswer<BoardData>();
    vi.mocked(api.editItem).mockReturnValueOnce(placed.promise);
    await renderBoard();
    openCard('Report');
    moveTo('later');
    // Today's row shows in Later while its park waits on the board's answer, its drag held. Its
    // card still opens, so it isn't named disabled.
    expect(titlesIn('Later')).toEqual(['Report', 'Write a KB']);
    expect(card('Report').hasAttribute('aria-disabled')).toBe(false);
    await pickUp('Report');
    expect(said()).toBe('');
    placed.resolve((onServer = withItemPatch(onServer, REPORT, { lane: 'later', before: 'later0000001' })));
    await settle();
    await pickUp('Report');
    expect(said()).toBe(BOARD_DRAG.pickedUp('Report', 'Later'));
    await press('Escape');
  });

  it('drags no item of In progress or Done below 900 px, where one column shows at a time, while a lane still sorts', async () => {
    stubMatchMedia(new Set());
    await renderBoard();
    for (const title of ['Report', 'Email']) expect(card(title).hasAttribute('aria-roledescription')).toBe(false);
    await pickUp('Report');
    expect(said()).toBe('');
    await pickUp('Write a KB');
    expect(said()).toBe(BOARD_DRAG.pickedUp('Write a KB', 'Later'));
    await press('Escape');
  });

  it("keeps Later's fold as it was while a card dragged in makes it ten", async () => {
    const later = Array.from({ length: 9 }, (_, i) => makeCard(`later${i}`.padEnd(12, 'x'), `Later ${i}`, { position: i + 1 }));
    onServer = makeBoard(...later, makeCard('next00000001', 'Follow up', { lane: 'next' }));
    await renderBoard();
    await pickUp('Follow up');
    await press('ArrowLeft');
    expect(titlesIn('Later')).toHaveLength(10);
    expect(screen.queryByRole('button', { name: /^Show all/ })).toBeNull();
    await press('Escape');
  });

  it("drags a card of Later's Repeats onto today's list, and puts it back with the board notice from Later or Next", async () => {
    onServer = { ...onServer, recurring: [makeRecurring('rec000000001', 'Monitor the queue')] };
    await renderBoard();
    const refused = BOARD.recurringStays('Monitor the queue');
    const close = () => within(notice()).getByRole('button', { name: BOARD.close });
    await pickUp('Monitor the queue');
    expect(said()).toBe(BOARD_DRAG.pickedUp('Monitor the queue', 'Later'));
    await press('ArrowRight');
    expect(titlesIn('Next')).toContain('Monitor the queue');
    await press('Space');
    expect(said()).toBe(refused);
    expect(notice().textContent).toContain(refused);
    expect(document.activeElement).toBe(close());
    expect(titlesIn('Later')).toEqual(['Write a KB', 'Monitor the queue']);
    fireEvent.click(close());
    expect(document.activeElement).toBe(card('Monitor the queue'));
    // Dropped in Later, among its cards, the same.
    await pickUp('Monitor the queue');
    await press('Space');
    expect(said()).toBe(refused);
    fireEvent.click(close());
    await settle();
    expect(api.editItem).not.toHaveBeenCalled();
    // Onto In progress: today's row, as any pull.
    await pickUp('Monitor the queue');
    await press('ArrowRight');
    await press('ArrowRight');
    expect(said()).toBe(BOARD_DRAG.over('Monitor the queue', 'In progress'));
    await press('Space');
    expect(putLists()).toEqual([{ date: WED, texts: ['Report', 'Email', 'Monitor the queue'] }]);
    expect(titlesIn('Later')).toEqual(['Write a KB']);
    expect(document.activeElement).toBe(card('Monitor the queue'));
  });

  it("doesn't drag a recurring row, which stays on today's list, and tells how every other card drags and opens", async () => {
    lists[WED] = [row(1, 'Monitor the queue', { uid: 'rec000000001', recurring: true }), row(2, 'Report')];
    await renderBoard();
    expect(card('Monitor the queue').hasAttribute('aria-roledescription')).toBe(false);
    await pickUp('Monitor the queue');
    expect(said()).toBe('');
    // Its Space is a button's, which opens it.
    expect(fireEvent.keyUp(card('Monitor the queue'), { key: ' ' })).toBe(true);
    for (const title of ['Plan B', 'Follow up', 'Report']) {
      expect(card(title).hasAttribute('aria-roledescription')).toBe(true);
      const described = card(title)
        .getAttribute('aria-describedby')!
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent);
      expect(described).toEqual([BOARD_DRAG.instructions]);
    }
  });
});

describe('categories', () => {
  const TICKETS = makeCategory('cat000000001', 'Tickets');
  const ADMIN = makeCategory('cat000000002', 'Admin', { color: 'teal' });
  const OLD = makeCategory('cat000000003', 'Old work', { color: 'gold', archived: true });
  /** A column's box, opened by its + when it isn't open yet. */
  const openBox = (column: string, name: string) => {
    if (!isOpen(name)) fireEvent.click(plus(column));
    return field(name);
  };
  const laterBox = () => openBox('Later', 'New card for Later');
  const chipOf = (box: HTMLElement) => within(box.closest<HTMLElement>('.board-add-box')!).getByRole('button', { name: /^Category for new cards: / });
  const captureChip = () => chipOf(laterBox());
  const pickOption = (name: string) => fireEvent.click(screen.getByRole('option', { name }));
  const capture = (title: string) => enter(laterBox(), title);
  const sentCategories = () => added().map((c) => c.categoryUid);

  beforeEach(() => {
    localStorage.clear();
    onServer = {
      ...makeBoard(makeCard('later0000001', 'Write a KB', { categoryUid: TICKETS.uid }), makeCard('planned00001', 'Plan B', { lane: 'next', listDate: THU })),
      categories: [TICKETS, ADMIN, OLD],
    };
    lists[WED] = [row(1, 'Report', { categoryUid: OLD.uid })];
    vi.mocked(api.addCategory).mockImplementation((c) => Promise.resolve(answered((onServer = withCategory(onServer, c)))));
  });

  it("shows each item's category on its meta line, a removed one included", async () => {
    await renderBoard();
    const meta = (name: string) => [...column(name).querySelectorAll('.board-card-meta')];
    expect(meta('Later').map((m) => m.textContent)).toEqual(['Tickets']);
    expect(meta('Later')[0]!.querySelector('.cat-dot')?.getAttribute('data-color')).toBe('blue');
    expect(meta('In progress').map((m) => m.textContent)).toEqual(['Old work']);
    // A card with none has no meta line.
    expect(meta('Next')).toEqual([]);
  });

  it("puts a recurring row's mark after its category", async () => {
    lists[WED] = [row(1, 'Monitor the queue', { uid: 'rec000000001', recurring: true, categoryUid: TICKETS.uid })];
    await renderBoard();
    const meta = column('In progress').querySelector('.board-card-meta')!;
    expect([...meta.children].map((c) => c.className)).toEqual(['board-card-category', 'repeat-mark']);
    expect(meta.textContent).toBe('Tickets');
  });

  it("sends a new item in the box's category, remembered on this device and shared by every column's box", async () => {
    await renderBoard();
    expect(captureChip().textContent).toBe('Category');
    fireEvent.click(captureChip());
    pickOption('Admin');
    expect(localStorage.getItem(USER_KEYS.captureCategory)).toBe(ADMIN.uid);
    capture('Call the vendor');
    capture('Order cables');
    // In progress's box reads it as it opens, and its row's task takes it.
    const today = openBox('In progress', 'New priority for today');
    expect(chipOf(today).getAttribute('aria-label')).toBe('Category for new cards: Admin');
    enter(today, 'Ring the bank');
    await settle();
    expect(sentCategories()).toEqual([ADMIN.uid, ADMIN.uid]);
    expect(lists[WED]!.find((p) => p.text === 'Ring the bank')?.categoryUid).toBe(ADMIN.uid);

    cleanup();
    await renderBoard();
    const next = openBox('Next', 'New card for Next');
    expect(chipOf(next).getAttribute('aria-label')).toBe('Category for new cards: Admin');
    fireEvent.click(chipOf(next));
    pickOption('No category');
    expect(localStorage.getItem(USER_KEYS.captureCategory)).toBe('');
    enter(next, 'No category this time');
    await settle();
    expect(sentCategories()).toEqual([ADMIN.uid, ADMIN.uid, null]);
  });

  it('changes the category of a box already open when another box picks one', async () => {
    await renderBoard();
    fireEvent.change(laterBox(), { target: { value: 'Half typed' } });
    fireEvent.click(chipOf(openBox('Next', 'New card for Next')));
    pickOption('Admin');
    expect(captureChip().getAttribute('aria-label')).toBe('Category for new cards: Admin');
    fireEvent.keyDown(laterBox(), { key: 'Enter' });
    await settle();
    expect(sentCategories()).toEqual([ADMIN.uid]);
  });

  it('reads a remembered category that was removed, or that the board lacks, as none', async () => {
    localStorage.setItem(USER_KEYS.captureCategory, OLD.uid);
    await renderBoard();
    expect(captureChip().getAttribute('aria-label')).toBe('Category for new cards: none');
    capture('A card');
    await settle();
    expect(sentCategories()).toEqual([null]);
  });

  it("makes a category from a box chip's New category, in the next colour, and uses it at once", async () => {
    await renderBoard();
    fireEvent.click(captureChip());
    const box = screen.getByRole('textbox', { name: 'New category' });
    fireEvent.change(box, { target: { value: 'Calls' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(captureChip().getAttribute('aria-label')).toBe('Category for new cards: Calls');
    capture('Call the vendor');
    await settle();
    const [made] = vi.mocked(api.addCategory).mock.calls[0]!;
    // Blue and teal are in use; the removed category's gold doesn't count.
    expect(made).toMatchObject({ name: 'Calls', color: 'green' });
    expect(sentCategories()).toEqual([made.uid]);
    expect(api.addCategory).toHaveBeenCalledTimes(1);
  });

  it("says in the banner when a category made from the chip isn't saved, and the chip reads none again", async () => {
    await renderBoard();
    vi.mocked(api.addCategory).mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(captureChip());
    const box = screen.getByRole('textbox', { name: 'New category' });
    fireEvent.change(box, { target: { value: 'Calls' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await settle();
    expect(warnSaveFailed).toHaveBeenCalledOnce();
    expect(captureChip().getAttribute('aria-label')).toBe('Category for new cards: none');
  });

  it("sets a row of today's category through the row, and a task's off today by a PATCH", async () => {
    await renderBoard();
    openCard('Report');
    fireEvent.click(screen.getByRole('button', { name: 'Category for Report: Old work' }));
    pickOption('Tickets');
    await settle();
    expect(putLists()).toEqual([{ date: WED, texts: ['Report', '', ''] }]);
    expect(lists[WED]![0]!.categoryUid).toBe(TICKETS.uid);

    closeCard();
    openCard('Write a KB');
    fireEvent.click(screen.getByRole('button', { name: 'Category for Write a KB: Tickets' }));
    pickOption('Admin');
    await settle();
    expect(api.editItem).toHaveBeenCalledExactlyOnceWith('later0000001', { categoryUid: ADMIN.uid });
    expect(column('Later').querySelector('.board-card-meta')?.textContent).toBe('Admin');
    // The dialog stays open, its chip on the new category.
    expect(screen.getByRole('button', { name: 'Category for Write a KB: Admin' })).toBe(document.activeElement);
  });

  it("sets a card's category and an earlier day's recurring row's by a PATCH, and offers none once that recurring priority stopped repeating", async () => {
    onServer = { ...onServer, recurring: [makeRecurring('rec000000009', 'Tuesday row')] };
    await renderBoard();
    openCard('Plan B');
    fireEvent.click(screen.getByRole('button', { name: 'Category for Plan B: none' }));
    pickOption('Admin');
    await settle();
    expect(api.editItem).toHaveBeenCalledExactlyOnceWith('planned00001', { categoryUid: ADMIN.uid });
    closeCard();
    fireEvent.click(screen.getByRole('button', { name: 'Earlier this week · 1' }));
    openCard('Tuesday row', 'Done');
    fireEvent.click(screen.getByRole('button', { name: 'Category for Tuesday row: none' }));
    pickOption('Tickets');
    await settle();
    expect(api.editItem).toHaveBeenLastCalledWith('rec000000009', { categoryUid: TICKETS.uid });
    expect(screen.getByRole('button', { name: 'Category for Tuesday row: Tickets' })).toBeTruthy();

    cleanup();
    onServer = { ...onServer, recurring: [] };
    serveRange([makeDay(TUE, { priorities: [{ ...tuesdayRoutine(), categoryUid: TICKETS.uid }] }), makeDay(MON)]);
    await renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Earlier this week · 1' }));
    openCard('Tuesday row');
    // Its category shows as text, as its title does.
    expect(screen.queryByRole('button', { name: /^Category for Tuesday row/ })).toBeNull();
    expect(within(dialog()).getByText('Tickets')).toBeTruthy();
  });
});
