// @vitest-environment happy-dom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../api';
import { warnSaveFailed } from '../../lib/alerts';
import { withCategory } from '../../lib/board';
import { USER_KEYS } from '../../lib/storage';
import { ADMIN, answered, makeBoard, makeCard, makeDay, makeRecurring, OLD_WORK, QUEUE, serveRange, settle, TICKETS } from '../../test/hooks';
import type { Board as BoardData, Priority } from '../../types';
import {
  added,
  closeCard,
  column,
  dialog,
  enter,
  field,
  isOpen,
  MON,
  openCard,
  plus,
  putLists,
  renderBoard,
  row,
  serveBoard,
  THU,
  TUE,
  tuesdayRoutine,
  WED,
} from './Board.testkit';

vi.mock('../../api');
vi.mock('../../lib/alerts');

let onServer: BoardData;
let lists: Record<string, Priority[]>;
serveBoard({ board: () => onServer, setBoard: (board) => (onServer = board), lists: () => lists, setLists: (fresh) => (lists = fresh) });

describe('categories', () => {
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
      categories: [TICKETS, ADMIN, OLD_WORK],
    };
    lists[WED] = [row(1, 'Report', { categoryUid: OLD_WORK.uid })];
    vi.mocked(api.addCategory).mockImplementation((c) => Promise.resolve(answered((onServer = withCategory(onServer, c)))));
  });

  it("shows each item's category on its meta line, a removed one included", async () => {
    await renderBoard();
    const meta = (name: string) => [...column(name).querySelectorAll('.board-card-meta')];
    expect(meta('Later').map((m) => m.textContent)).toEqual(['Tickets']);
    expect(meta('Later')[0]!.querySelector('.cat-dot')?.getAttribute('data-color')).toBe('blue');
    expect(meta('In Progress').map((m) => m.textContent)).toEqual(['Old work']);
    // A card with none has no meta line.
    expect(meta('Next')).toEqual([]);
  });

  it("puts a recurring row's mark after its category", async () => {
    lists[WED] = [row(1, 'Monitor the queue', { uid: QUEUE.uid, recurring: true, categoryUid: TICKETS.uid })];
    await renderBoard();
    const meta = column('In Progress').querySelector('.board-card-meta')!;
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
    // In Progress's box reads it as it opens, and its row's task takes it.
    const today = openBox('In Progress', 'New priority for today');
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
    localStorage.setItem(USER_KEYS.captureCategory, OLD_WORK.uid);
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
    fireEvent.click(screen.getByRole('button', { name: 'Earlier This Week' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Earlier This Week' }));
    openCard('Tuesday row');
    // Its category shows as text, as its title does.
    expect(screen.queryByRole('button', { name: /^Category for Tuesday row/ })).toBeNull();
    expect(within(dialog()).getByText('Tickets')).toBeTruthy();
  });
});
