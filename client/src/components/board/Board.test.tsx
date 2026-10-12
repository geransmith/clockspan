// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import * as api from '../../api';
import { AuthGate } from '../../auth/AuthGate';
import { LOOKBACK_DAYS } from '../../../../shared/api.js';
import { addDays, DAY_MS, HOUR_MS, MINUTE_MS } from '../../../../shared/dates.js';
import { SettingsProvider } from '../../hooks/useSettings';
import { unlockAudio, warnQuietly, warnSaveFailed } from '../../lib/alerts';
import { withItemPatch, withoutItem } from '../../lib/board';
import { BOARD, CONFIRM, DONE_STAYS, LOAD_FAILED, PRIORITY_WARNINGS, WARNING_ACTIONS } from '../../lib/copy';
import { dayName, formatDateLong } from '../../lib/format';
import {
  answered,
  completedSession,
  DEFAULT_USER,
  deferredAnswer,
  FOLLOW_UPS,
  makeBoard,
  makeCard,
  makeAuth,
  makeDay,
  makeSession,
  makeRecurring,
  makeSettings,
  QUEUE,
  serveRange,
  settle,
} from '../../test/hooks';
import type { Board as BoardData, Priority, RangeResponse } from '../../types';
import { Header } from '../Header';
import {
  added,
  changedElsewhere,
  column,
  dialog,
  EMAIL,
  field,
  fullBoard,
  MON,
  moveButton,
  moveOptions,
  moveTo,
  NOW,
  notice,
  openCard,
  plus,
  putLists,
  renderBoard,
  REPORT,
  row,
  serveBoard,
  shownColumns,
  THU,
  titlesIn,
  TUE,
  tuesdayRoutine,
  WED,
} from './Board.testkit';

vi.mock('../../api');
vi.mock('../../lib/alerts');

let onServer: BoardData;
let lists: Record<string, Priority[]>;
serveBoard({ board: () => onServer, setBoard: (board) => (onServer = board), lists: () => lists, setLists: (fresh) => (lists = fresh) });

/** App's header, whose Board button stays as the board's page changes. */
async function renderHeader() {
  vi.mocked(api.getAuth).mockResolvedValue(makeAuth({ mode: 'none', user: DEFAULT_USER }));
  render(
    <AuthGate>
      <SettingsProvider>
        <Header view="board" onNavigate={vi.fn()} onOpenSettings={vi.fn()} laterOpen={false} laterShut={false} onOpenLater={vi.fn()} onCloseLater={vi.fn()} />
      </SettingsProvider>
    </AuthGate>,
  );
  await settle();
}

describe('Board', () => {
  it("shows Later, Next, today's open rows in In Progress and this week in Done", async () => {
    await renderBoard();
    expect(titlesIn('Later')).toEqual(['Write a KB']);
    expect(titlesIn('Next')).toEqual(['Follow up', 'Plan B']);
    expect(titlesIn('In Progress')).toEqual(['Report']);
    expect(titlesIn('Done')).toEqual(['Email', 'Earlier This Week · 2']);
    fireEvent.click(screen.getByRole('button', { name: 'Earlier This Week · 2' }));
    expect(titlesIn('Done')).toEqual(['Email', 'Earlier This Week · 2', 'Shipped', 'Tuesday row']);
    expect(screen.getByRole('button', { name: 'Earlier This Week · 2' }).getAttribute('aria-expanded')).toBe('true');
  });

  // A touch screen hides the key too, by CSS (`.board-key`), which happy-dom doesn't load.
  it('says what goes in an empty Later and Next, naming N only while the key is on', async () => {
    onServer = makeBoard();
    await renderBoard();
    const later = within(column('Later')).getByText(/Nothing parked/);
    expect(later.textContent).toBe('Nothing parked. N or + adds a card.');
    expect(later.querySelector('.board-key')?.textContent).toBe('N or ');
    expect(within(column('Next')).getByText('Tasks left open on earlier days wait here for two weeks.')).toBeTruthy();
    cleanup();
    await renderBoard(makeSettings({ shortcuts: false }));
    const keyless = within(column('Later')).getByText(/Nothing parked/);
    expect(keyless.textContent).toBe('Nothing parked. + adds a card.');
    expect(keyless.querySelector('.board-key')).toBeNull();
  });

  it("names the day on a routine's earlier ticks, which read alike, and counts the fold only beside today's done items", async () => {
    serveRange([makeDay(TUE, { priorities: [tuesdayRoutine()] }), makeDay(MON, { priorities: [tuesdayRoutine()] })]);
    await renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Earlier This Week · 3' }));
    const cards = [...column('Done').querySelectorAll('.board-card')];
    expect(cards.map((c) => [c.querySelector('.board-card-title')?.textContent, c.querySelector('.board-card-meta')?.textContent ?? null])).toEqual([
      ['Email', null],
      ['Shipped', null],
      ['Tuesday row', 'Done yesterday'],
      ['Tuesday row', `Done ${dayName(MON, WED, true)}`],
    ]);
    // With nothing done today, the fold's count would be the column's.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Email done' }));
    await settle();
    expect(titlesIn('Done')).toEqual(['Earlier This Week', 'Shipped', 'Tuesday row', 'Tuesday row']);
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
    expect(within(dialog()).getByText(BOARD.leavesNext(formatDateLong(addDays(TUE, LOOKBACK_DAYS + 1))))).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Title' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Category for Check the logs: none' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    // Next too: it has no place of its own there yet.
    expect(moveOptions()).toEqual(['Later', 'Next', 'In Progress', 'Done']);
    moveTo('next');
    await settle();
    expect(api.editItem).toHaveBeenCalledExactlyOnceWith('left00000001', { lane: 'next', before: null });
    expect(titlesIn('Next')).toEqual(['Follow up', 'Plan B', 'Check the logs']);
    expect(within(column('Next')).queryByText('Left open from yesterday')).toBeNull();
  });

  it('moves a task between Later and Next with Move to', async () => {
    await renderBoard();
    openCard('Write a KB');
    expect(moveOptions()).toEqual(['Next', 'In Progress', 'Done']);
    moveTo('next');
    await settle();
    expect(api.editItem).toHaveBeenCalledExactlyOnceWith('later0000001', { lane: 'next', before: null });
    expect(titlesIn('Next')).toEqual(['Follow up', 'Plan B', 'Write a KB']);
  });

  it("pulls a task into In Progress: the task itself on today's list", async () => {
    await renderBoard();
    openCard('Follow up');
    moveTo('progress');
    await settle();
    expect(putLists()).toEqual([{ date: WED, texts: ['Report', 'Email', 'Follow up'] }]);
    expect(lists[WED]![2]).toMatchObject({ uid: 'next00000001', done: false });
    expect(titlesIn('In Progress')).toEqual(['Report', 'Follow up']);
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
    expect(titlesIn('Done')).toEqual(['Email', 'Follow up', 'Earlier This Week · 2']);
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

  it("puts a task ticked on a later day with today's in Done, with no tick, its dialog saying when its sheet can untick it", async () => {
    onServer = makeBoard(...onServer.cards, makeCard('ahead0000001', 'Ticked ahead', { lane: null, listDate: THU, listDone: true, listed: 1 }));
    await renderBoard();
    expect(titlesIn('Done')).toEqual(['Email', 'Ticked ahead', 'Earlier This Week · 2']);
    expect(screen.queryByRole('checkbox', { name: 'Ticked ahead done' })).toBeNull();
    openCard('Ticked ahead');
    expect(within(dialog()).getByText(BOARD.doneAhead('tomorrow'))).toBeTruthy();
    expect(moveOptions()).toEqual(['Later', 'Next', 'In Progress']);
  });

  it('gives a task done on an earlier day no tick, saying where to untick it, and Move to brings it back', async () => {
    await renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Earlier This Week · 2' }));
    expect(screen.queryByRole('checkbox', { name: 'Shipped done' })).toBeNull();
    openCard('Shipped');
    expect(dialog().getAttribute('aria-label')).toBe('Shipped');
    expect(within(dialog()).getByText(BOARD.doneOn('yesterday'))).toBeTruthy();
    expect(within(dialog()).getByRole('textbox', { name: 'Title' })).toBeTruthy();
    expect(within(dialog()).getByRole('button', { name: 'Category for Shipped: none' })).toBeTruthy();
    expect(within(dialog()).getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(moveOptions()).toEqual(['Later', 'Next', 'In Progress']);
    moveTo('progress');
    await settle();
    expect(lists[WED]![2]).toMatchObject({ uid: 'done00000001', text: 'Shipped', done: false });
    expect(titlesIn('In Progress')).toEqual(['Report', 'Shipped']);
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
    fireEvent.click(screen.getByRole('button', { name: 'Earlier This Week · 2' }));
    openCard('Shipped');
    const title = screen.getByRole('textbox', { name: 'Title' });
    fireEvent.change(title, { target: { value: 'Shipped v2' } });
    fireEvent.keyDown(title, { key: 'Enter' });
    await settle();
    expect(api.editItem).toHaveBeenCalledExactlyOnceWith('done00000001', { title: 'Shipped v2' });
    expect(titlesIn('Done')).toEqual(['Email', 'Earlier This Week · 2', 'Shipped v2', 'Tuesday row']);

    openCard('Shipped v2');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(confirm).toHaveBeenCalledWith(CONFIRM.deleteTask(2, '25m'));
    await settle();
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(api.deleteItem).toHaveBeenCalledExactlyOnceWith('done00000001');
    expect(titlesIn('Done')).toEqual(['Email', 'Earlier This Week · 1', 'Tuesday row']);
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
    expect(titlesIn('In Progress')).toEqual([]);
    expect(screen.getByText("Nothing open on today's Top Priorities.")).toBeTruthy();
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
      expect(uid).toMatch(/^[0-9a-f]{32}$/);
      expect(uid).not.toBe(EMAIL);
      expect(titlesIn('Done')).toContain('Email');
      expect(titlesIn('Next')).toEqual(['Follow up', 'Plan B', 'Email']);
      // Later's new task goes at the top, as Later's + puts one.
      fireEvent.click(screen.getByRole('button', { name: 'Earlier This Week · 2' }));
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

  it("offers a recurring row no Later or Next, only Remove From Today, which takes it off today's list, closing its dialog with the focus near it, a failed remove too", async () => {
    lists[WED] = [row(1, 'Monitor the queue', { uid: QUEUE.uid, recurring: true })];
    await renderBoard();
    openCard('Monitor the queue');
    expect(moveOptions()).toEqual(['Done']);
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    vi.mocked(api.putPriorities).mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove From Today' }));
    await settle();
    // The day store put the row back and read the day again.
    expect(titlesIn('In Progress')).toEqual(['Monitor the queue']);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(plus('In Progress'));
    openCard('Monitor the queue');
    fireEvent.click(screen.getByRole('button', { name: 'Remove From Today' }));
    await settle();
    expect(putLists()).toEqual([
      { date: WED, texts: ['', '', ''] },
      { date: WED, texts: ['', '', ''] },
    ]);
    expect(titlesIn('In Progress')).toEqual([]);
    expect(document.activeElement).toBe(plus('In Progress'));
    expect(api.deleteItem).not.toHaveBeenCalled();
  });

  /** The lines under the title in the open dialog: where it is renamed, or changed. */
  const dialogLines = () => [...dialog().querySelectorAll('p.muted.small')].map((p) => p.textContent);

  it("renames today's recurring row through the row, which renames the recurring priority and its earlier ticks at once, and keeps its chip, its tick and Remove From Today", async () => {
    onServer = { ...onServer, recurring: [QUEUE] };
    lists[WED] = [row(1, 'Monitor the queue', { uid: QUEUE.uid, recurring: true, listed: 2 }), row(2, 'Report')];
    serveRange([makeDay(TUE, { priorities: [row(1, 'Monitor the queue', { uid: QUEUE.uid, recurring: true, done: true })] })]);
    await renderBoard();
    openCard('Monitor the queue');
    expect(dialogLines()).toEqual([]);
    expect(within(dialog()).getByRole('button', { name: 'Category for Monitor the queue: none' })).toBeTruthy();
    expect(within(dialog()).getByRole('button', { name: 'Remove From Today' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Monitor the queue done' })).toBeTruthy();
    const title = within(dialog()).getByRole('textbox', { name: 'Title' });
    fireEvent.change(title, { target: { value: 'Watch the queue' } });
    fireEvent.keyDown(title, { key: 'Enter' });
    await settle();
    expect(putLists()).toEqual([{ date: WED, texts: ['Watch the queue', 'Report', ''] }]);
    expect(api.editItem).not.toHaveBeenCalled();
    // Tuesday's tick shows its recurring priority's new name, and the days on screen are read again.
    // Nothing is done today, so the fold doesn't repeat the column's count.
    fireEvent.click(screen.getByRole('button', { name: 'Earlier This Week' }));
    expect(titlesIn('Done')).toEqual(['Earlier This Week', 'Shipped', 'Watch the queue']);
    expect(vi.mocked(api.getRange)).toHaveBeenCalledTimes(2);
  });

  it("renames today's recurring row through the row once its recurring priority stopped repeating too", async () => {
    lists[WED] = [row(1, 'Monitor the queue', { uid: QUEUE.uid, recurring: true })];
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
    fireEvent.click(screen.getByRole('button', { name: 'Earlier This Week · 2' }));
    openCard('Tuesday row', 'Done');
    expect(dialogLines()).toEqual([]);
    expect(moveOptions()).toEqual(['In Progress']);
    const title = screen.getByRole('textbox', { name: 'Title' });
    fireEvent.change(title, { target: { value: 'Tuesday task' } });
    fireEvent.keyDown(title, { key: 'Enter' });
    await settle();
    expect(api.editItem).toHaveBeenCalledExactlyOnceWith('rec000000009', { title: 'Tuesday task' });
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(onServer.recurring[0]!.title).toBe('Tuesday task');
    expect(titlesIn('Done')).toEqual(['Email', 'Earlier This Week · 2', 'Shipped', 'Tuesday task']);

    cleanup();
    onServer = { ...onServer, recurring: [] };
    await renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Earlier This Week · 2' }));
    openCard('Tuesday row');
    expect(screen.queryByRole('textbox', { name: 'Title' })).toBeNull();
    expect(within(dialog()).getByRole('heading', { name: 'Tuesday row' })).toBeTruthy();
    expect(dialogLines()).toEqual([]);
    // Stopped, it doesn't go back on today's list.
    expect(screen.queryByRole('group', { name: 'Move to' })).toBeNull();
  });

  it("marks a recurring row on its meta line, and only that row, with Repeats as its card's title, or the note's start on one with a note", async () => {
    lists[WED] = [
      row(1, 'Monitor the queue', { uid: QUEUE.uid, recurring: true }),
      row(2, 'Report'),
      row(3, 'Follow-ups', { uid: FOLLOW_UPS.uid, recurring: true, note: 'Kim first.' }),
    ];
    await renderBoard();
    const metas = [...column('In Progress').querySelectorAll('.board-card-meta')];
    expect(metas.map((m) => m.closest('.board-card')?.querySelector('.board-card-title')?.textContent)).toEqual(['Monitor the queue', 'Follow-ups']);
    for (const m of metas) within(m as HTMLElement).getByRole('img', { name: 'Repeats' });
    // The mark's own title lies under the card's button, which takes the hover.
    expect([...column('In Progress').querySelectorAll('.board-card-open')].map((b) => [b.textContent, b.getAttribute('title')])).toEqual([
      ['Monitor the queue', 'Repeats'],
      ['Report', null],
      ['Follow-ups', 'Kim first.'],
    ]);
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
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await settle();
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(api.deleteItem).toHaveBeenCalledExactlyOnceWith(REPORT);
    expect(titlesIn('In Progress')).toEqual([]);
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
    // Done has no +, and the items folded under Earlier This Week take no focus: its heading does.
    openCard('Email');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await settle();
    expect(titlesIn('Done')).toEqual(['Earlier This Week']);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Done' }));
    // happy-dom focuses any heading; a browser only one with a tabindex.
    expect(screen.getByRole('heading', { name: 'Done' }).getAttribute('tabindex')).toBe('-1');
  });

  it("shows today's row parked in a lane where it lands, with no tick, rename, category, Move to or Remove until the park lands", async () => {
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
    // A move planned from where it shows would be wrong: Done would tick a row the park takes off.
    expect(screen.queryByRole('group', { name: 'Move to' })).toBeNull();
    placed.resolve((onServer = withItemPatch(onServer, REPORT, { lane: 'next', before: null })));
    await settle();
    expect(titlesIn('Next')).toEqual(['Follow up', 'Plan B', 'Report', 'Check the logs']);
    // The dialog left open takes them once it lands.
    expect(screen.getByRole('textbox', { name: 'Title' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Category for Report: none' })).toBeTruthy();
    expect(moveOptions()).toEqual(['Later', 'In Progress', 'Done']);
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
    expect(moveOptions()).toEqual(['Next', 'In Progress', 'Done']);
    onServer = withItemPatch(onServer, 'later0000001', { lane: 'next', before: null });
    changedElsewhere();
    await settle();
    expect(titlesIn('Next')).toEqual(['Follow up', 'Plan B', 'Write a KB']);
    expect(moveOptions()).toEqual(['Later', 'In Progress', 'Done']);
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
    expect(titlesIn('In Progress')).toEqual(['Report']);
  });

  it("shows a Try again for a list of today that could not be read, handing the focus to the header's Board button as it goes", async () => {
    vi.mocked(api.getDay).mockRejectedValueOnce(new Error('offline'));
    await renderBoard();
    await renderHeader();
    expect(screen.getByText(new RegExp(LOAD_FAILED.title))).toBeTruthy();
    expect(warnQuietly).not.toHaveBeenCalled();
    const retry = screen.getByRole('button', { name: 'Try Again' });
    retry.focus();
    fireEvent.click(retry);
    await settle();
    expect(titlesIn('In Progress')).toEqual(['Report']);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Board' }));
  });

  it("shows today's failed read beside the board's, since no banner says it on the board", async () => {
    vi.mocked(api.getBoard).mockRejectedValue(new Error('offline'));
    vi.mocked(api.getDay).mockRejectedValueOnce(new Error('offline'));
    await renderBoard();
    expect(screen.getAllByRole('alert').map((a) => a.querySelector('strong')?.textContent)).toEqual([`${LOAD_FAILED.board}.`, `${LOAD_FAILED.title}.`]);
  });

  it('shows one column at a time from the switch, In Progress first', async () => {
    await renderBoard();
    expect(shownColumns()).toEqual(['In Progress']);
    fireEvent.click(within(screen.getByRole('group', { name: 'Board column' })).getByRole('button', { name: 'Later' }));
    expect(shownColumns()).toEqual(['Later']);
  });

  it("shows a Try again for a board that could not be read, which keeps the focus until it goes and then hands it to the header's Board button", async () => {
    vi.mocked(api.getBoard).mockRejectedValue(new Error('offline'));
    vi.mocked(api.getDay).mockRejectedValueOnce(new Error('offline'));
    await renderBoard();
    await renderHeader();
    const retry = screen.getAllByRole('button', { name: 'Try Again' })[0]!;
    retry.focus();
    fireEvent.click(retry);
    await settle();
    // Failed again: it stays, so a second press reads again rather than leaving the board.
    expect(document.activeElement).toBe(retry);
    vi.mocked(api.getBoard).mockImplementation(() => Promise.resolve(answered(onServer)));
    fireEvent.click(retry);
    await settle();
    // Today's notice stays, and the board's took the focus with it.
    expect(screen.getAllByRole('alert').map((a) => a.querySelector('strong')?.textContent)).toEqual([`${LOAD_FAILED.title}.`]);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Board' }));
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    await settle();
    expect(titlesIn('Later')).toEqual(['Write a KB']);
  });

  it("shows a Try again in Done for this week's earlier days that could not be read, which reads them again and hands the focus to Done's heading", async () => {
    onServer = makeBoard();
    lists = {};
    serveRange([]);
    vi.mocked(api.getRange).mockRejectedValueOnce(new Error('offline'));
    await renderBoard();
    const done = within(column('Done'));
    expect(done.getByRole('alert').textContent).toContain(LOAD_FAILED.range);
    // A routine ticked on those days may be all Done has, so it doesn't say there is nothing.
    expect(done.queryByText('Nothing done this week.')).toBeNull();
    expect(warnQuietly).not.toHaveBeenCalled();
    fireEvent.click(done.getByRole('button', { name: LOAD_FAILED.retry }));
    expect(document.activeElement).toBe(done.getByRole('heading', { name: 'Done' }));
    await settle();
    expect(done.queryByRole('alert')).toBeNull();
    expect(done.getByText('Nothing done this week.')).toBeTruthy();
    expect(api.getRange).toHaveBeenCalledTimes(2);
  });

  it("says nothing is done only once this week's earlier days are read, and at once on a Monday, which has none", async () => {
    onServer = makeBoard();
    lists = {};
    const range = deferredAnswer<RangeResponse>();
    vi.mocked(api.getRange).mockReturnValueOnce(range.promise);
    const at = await renderBoard();
    // A routine ticked on those days may be all Done has.
    expect(within(column('Done')).queryByText('Nothing done this week.')).toBeNull();
    range.resolve({ days: [makeDay(TUE)] });
    await settle();
    expect(within(column('Done')).getByText('Nothing done this week.')).toBeTruthy();
    at(NOW - 2 * DAY_MS, MON);
    await settle();
    expect(within(column('Done')).getByText('Nothing done this week.')).toBeTruthy();
  });
});
