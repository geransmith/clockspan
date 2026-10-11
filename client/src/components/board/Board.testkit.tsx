import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, vi } from 'vitest';
import * as api from '../../api';
import { BOARD_LIMITS } from '../../../../shared/api.js';
import type { TimerCtx } from '../../hooks/useTimer';
import { COLUMN_NAMES, withItem, withItemPatch, withoutItem, type ColumnId } from '../../lib/board';
import { answered, makeBoard, makeCard, makeDay, makePriority, makeSettings, serveRange, settle, SettingsAndDays, ShortcutKeys } from '../../test/hooks';
import type { Board as BoardData, Priority, Session } from '../../types';
import { Board } from './Board';

// What the Board.*.test.tsx files share. Each one mocks '../../api' and '../../lib/alerts' itself,
// since `vi.mock` applies only in the file that calls it.

// A Wednesday, so Done has a Monday and a Tuesday before today.
export const MON = '2026-09-28';
export const TUE = '2026-09-29';
export const WED = '2026-09-30';
export const THU = '2026-10-01';
export const NOW = new Date(2026, 8, 30, 10).getTime();

/** A task on a day's list; its uid is the task's, `row<position>` unless given. */
export const row = (position: number, text: string, patch: Partial<Priority> = {}) =>
  makePriority(position, text, { uid: `row${position}`.padEnd(12, 'x'), ...patch });
/** Today's two tasks, as the board has them too: the server sends every task listed in the last two weeks. */
export const REPORT = 'row1xxxxxxxx';
export const EMAIL = 'row2xxxxxxxx';
/** A recurring priority's row, ticked on Tuesday. */
export const tuesdayRoutine = () => row(1, 'Tuesday row', { uid: 'rec000000009', recurring: true, done: true });
/** Later and Next at the cap. */
export const fullBoard = () => Array.from({ length: BOARD_LIMITS.openCards }, (_, i) => makeCard(`c${i}`.padEnd(12, 'x'), `Card ${i}`, { position: i + 1 }));

/** The timer's start as App hands it to the board: it waits for the uid it is given, as `useTimer` does, so a failed pull fails it. */
export const start = vi.fn<TimerCtx['start']>();

/**
 * Before each case: the clock at NOW, then the server's board and lists, and the api answering from
 * them. They are the test file's own `let onServer` and `let lists`, which its cases set too, so the
 * file hands over reading and setting them.
 */
export function serveBoard(server: {
  board: () => BoardData;
  setBoard: (board: BoardData) => BoardData;
  lists: () => Record<string, Priority[]>;
  setLists: (lists: Record<string, Priority[]>) => void;
}) {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    server.setBoard(
      makeBoard(
        makeCard('later0000001', 'Write a KB'),
        makeCard('next00000001', 'Follow up', { lane: 'next' }),
        makeCard('planned00001', 'Plan B', { lane: 'next', position: 2, listDate: THU, listed: 1 }),
        makeCard('done00000001', 'Shipped', { lane: null, listDate: TUE, listDone: true, listed: 1 }),
        makeCard(REPORT, 'Report', { lane: null, listDate: WED, listed: 1 }),
        makeCard(EMAIL, 'Email', { lane: null, listDate: WED, listDone: true, listed: 1 }),
      ),
    );
    server.setLists({ [WED]: [row(1, 'Report'), row(2, 'Email', { done: true })] });
    vi.mocked(api.getDay).mockImplementation((date) => Promise.resolve(answered(makeDay(date, { priorities: server.lists()[date] ?? [] }))));
    serveRange([makeDay(TUE, { priorities: [tuesdayRoutine()] }), makeDay(MON)]);
    vi.mocked(api.putPriorities).mockImplementation((date, list) => Promise.resolve(answered({ priorities: (server.lists()[date] = list) })));
    vi.mocked(api.getBoard).mockImplementation(() => Promise.resolve(answered(server.board())));
    vi.mocked(api.addItem).mockImplementation((item) => Promise.resolve(answered(server.setBoard(withItem(server.board(), item, NOW)))));
    vi.mocked(api.editItem).mockImplementation((uid, patch) => Promise.resolve(answered(server.setBoard(withItemPatch(server.board(), uid, patch)))));
    vi.mocked(api.deleteItem).mockImplementation((uid) => {
      const lists = server.lists();
      for (const [date, list] of Object.entries(lists)) lists[date] = list.filter((p) => p.uid !== uid);
      return Promise.resolve(answered(server.setBoard(withoutItem(server.board(), uid))));
    });
    start.mockImplementation(async (_date, _seconds, _label, uid) => {
      await uid;
    });
  });
}

/**
 * Renders the board at `now`, the minute App hands it, with the timer App hands it (none running,
 * no start out); the answer renders it again at another minute.
 */
export async function renderBoard(
  settings = makeSettings(),
  now = NOW,
  { running = null, starting = false }: { running?: Session | null; starting?: boolean } = {},
) {
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
export const column = (name: string) => screen.getByRole('region', { name });
/** The board notice's live region (drag and drop has a live region of its own). */
export const notice = () => document.querySelector<HTMLElement>('.board-notice[role="status"]')!;
/** The titles a column shows, in order, and Done's fold. */
export const titlesIn = (name: string) => [...column(name).querySelectorAll('.board-card-title, .board-earlier')].map((b) => b.textContent);
/** The open card's dialog. */
export const dialog = () => screen.getByRole('dialog');
/** Opens an item's dialog by its card, in the column named when two show the title. Nothing behind an open dialog takes a press in a browser, so none is open. */
export const openCard = (title: string, inColumn?: string) => {
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click((inColumn ? within(column(inColumn)) : screen).getByRole('button', { name: title }));
};
/** Closes the open dialog with Escape. */
export const closeCard = () => fireEvent.keyDown(dialog(), { key: 'Escape' });
/** Says another device saved a change, which the board answers with a read. */
export const changedElsewhere = () => act(() => void window.dispatchEvent(new CustomEvent(api.CHANGED_ELSEWHERE)));
/** The open dialog's Move to, and its column buttons. */
const moveGroup = () => screen.getByRole('group', { name: 'Move to' });
export const moveButton = (to: ColumnId) => within(moveGroup()).getByRole('button', { name: COLUMN_NAMES[to] });
export const moveTo = (to: ColumnId) => fireEvent.click(moveButton(to));
export const moveOptions = () =>
  within(moveGroup())
    .getAllByRole('button')
    .map((b) => b.textContent);
export const putLists = () => vi.mocked(api.putPriorities).mock.calls.map(([date, list]) => ({ date, texts: list.map((p) => p.text) }));
/** The tasks a lane's box and Add a new card sent. */
export const added = () => vi.mocked(api.addItem).mock.calls.map(([item]) => item);
/** A column's + by its heading. */
export const plus = (name: string) => screen.getByRole('button', { name: `Add to ${name}` });
/** A column's box by its field's name. */
export const field = (name: string) => screen.getByRole('textbox', { name }) as HTMLInputElement;
export const isOpen = (name: string) => screen.queryByRole('textbox', { name }) !== null;
/** Types into a box and presses Enter. */
export const enter = (box: HTMLElement, text: string) => {
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: 'Enter' });
};
/** The columns a phone shows, one at a time. */
export const shownColumns = () => [...document.querySelectorAll('.board-col[data-shown]')].map((c) => c.querySelector('h2')!.textContent);
