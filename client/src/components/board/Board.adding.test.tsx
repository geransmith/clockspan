// @vitest-environment happy-dom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import * as api from '../../api';
import { MAX_PRIORITIES } from '../../../../shared/settings.js';
import { withItemPatch } from '../../lib/board';
import { ADD_PRIORITY_FAILED, BOARD, DONE_STAYS, PRIORITY_WARNINGS, WARNING_ACTIONS } from '../../lib/copy';
import { deferredAnswer, makeBoard, pressKey, settle } from '../../test/hooks';
import type { Board as BoardData, Priority } from '../../types';
import {
  added,
  enter,
  field,
  fullBoard,
  isOpen,
  moveTo,
  notice,
  openCard,
  plus,
  putLists,
  renderBoard,
  REPORT,
  row,
  serveBoard,
  shownColumns,
  titlesIn,
  WED,
} from './Board.testkit';

vi.mock('../../api');
vi.mock('../../lib/alerts');

let onServer: BoardData;
let lists: Record<string, Priority[]>;
serveBoard({ board: () => onServer, setBoard: (board) => (onServer = board), lists: () => lists, setLists: (fresh) => (lists = fresh) });

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
    expect(shownColumns()).toEqual(['In Progress']);
    fireEvent.click(plus('Later'));
    expect(shownColumns()).toEqual(['Later']);
    expect(document.activeElement).toBe(field('New card for Later'));
  });

  // L is also the header's Add to Later, which presses Later's + by its id on the Board.
  it("opens Later's box on N and on L, showing Later on a phone, with both named on Later's + while it would open", async () => {
    for (const key of ['n', 'l']) {
      await renderBoard();
      expect(plus('Later').id).toBe('board-add-later-button');
      expect(plus('Later').getAttribute('aria-keyshortcuts')).toBe('N L');
      expect(plus('Next').hasAttribute('aria-keyshortcuts')).toBe(false);
      expect(pressKey(key), key).toBe(false);
      expect(shownColumns()).toEqual(['Later']);
      expect(document.activeElement).toBe(field('New card for Later'));
      cleanup();
    }
    onServer = makeBoard(...fullBoard());
    await renderBoard();
    expect(plus('Later').hasAttribute('aria-keyshortcuts')).toBe(false);
    expect([pressKey('n'), pressKey('l')]).toEqual([true, true]);
    expect(isOpen('New card for Later')).toBe(false);
  });

  // With today's list unread there is no Later's + to stand for, so N mustn't leave its box to open once it is.
  it("leaves N alone while today's list could not be read", async () => {
    vi.mocked(api.getDay).mockRejectedValueOnce(new Error('offline'));
    await renderBoard();
    expect(pressKey('n')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    await settle();
    expect(isOpen('New card for Later')).toBe(false);
  });

  it("shuts Later's and Next's + at the cap and In Progress's on a full list, saying why under each, where Tab still reaches it", async () => {
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
    expect(shownColumns()).toEqual(['In Progress']);
    // A task typed in In Progress has no lane: the cap doesn't count it.
    expect(plus('In Progress').getAttribute('aria-disabled')).toBeNull();
    expect(plus('In Progress').getAttribute('aria-describedby')).toBeNull();
    fireEvent.click(plus('In Progress'));
    enter(field('New priority for today'), 'Call the vendor');
    await settle();
    expect(putLists()).toEqual([{ date: WED, texts: ['Report', 'Email', 'Call the vendor'] }]);

    cleanup();
    onServer = makeBoard();
    lists[WED] = Array.from({ length: MAX_PRIORITIES }, (_, i) => row(i + 1, `Task ${i + 1}`));
    await renderBoard();
    expect(plus('In Progress').getAttribute('aria-disabled')).toBe('true');
    expect(why(plus('In Progress'))).toBe(ADD_PRIORITY_FAILED.full);
    fireEvent.click(plus('In Progress'));
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

  it("adds a task to today's list from In Progress's box on the board's queue, after a board write still out, and keeps the box", async () => {
    const placed = deferredAnswer<BoardData>();
    vi.mocked(api.editItem).mockReturnValueOnce(placed.promise);
    await renderBoard();
    openCard('Report');
    moveTo('later');
    fireEvent.click(plus('In Progress'));
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
    expect(lists[WED]![0]!.uid).toMatch(/^[0-9a-f]{32}$/);
    expect(api.addItem).not.toHaveBeenCalled();
    expect(titlesIn('In Progress')).toEqual(['Call the vendor']);
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
    fireEvent.click(plus('In Progress'));
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
    fireEvent.click(plus('In Progress'));
    const box = field('New priority for today');
    enter(box, 'Call the vendor');
    expect(notice().textContent).toBe('');
    await settle();
    // Row 3 is free again.
    enter(box, 'Book the room');
    expect(notice().textContent).toBe('');
  });

  it("asks first from In Progress's box past the nudge: Keep it short leaves the text in the box, Add anyway adds it, closes the box and focuses the new row", async () => {
    lists[WED] = [row(1, 'Report'), row(2, 'Email'), row(3, 'Invoices')];
    await renderBoard();
    fireEvent.click(plus('In Progress'));
    const box = field('New priority for today');
    enter(box, 'Call the vendor');
    expect(PRIORITY_WARNINGS.fresh).toContain(within(notice()).getByText(/./, { selector: 'span:not(.notice-actions)' }).textContent);
    expect(document.activeElement).toBe(within(notice()).getByRole('button', { name: WARNING_ACTIONS.fresh.add }));
    expect(box.value).toBe('Call the vendor');
    // On a phone the notice stays up while another column shows: its answer shows In Progress again.
    const show = (name: string) => fireEvent.click(within(screen.getByRole('group', { name: 'Board column' })).getByRole('button', { name }));
    show('Next');
    fireEvent.click(within(notice()).getByRole('button', { name: WARNING_ACTIONS.fresh.keep }));
    expect(within(notice()).queryByRole('button')).toBeNull();
    expect(shownColumns()).toEqual(['In Progress']);
    expect(document.activeElement).toBe(box);
    expect(box.value).toBe('Call the vendor');
    await settle();
    expect(api.putPriorities).not.toHaveBeenCalled();

    fireEvent.keyDown(box, { key: 'Enter' });
    show('Later');
    fireEvent.click(within(notice()).getByRole('button', { name: WARNING_ACTIONS.fresh.add }));
    expect(isOpen('New priority for today')).toBe(false);
    expect(shownColumns()).toEqual(['In Progress']);
    await settle();
    expect(putLists()).toEqual([{ date: WED, texts: ['Report', 'Email', 'Invoices', 'Call the vendor'] }]);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Call the vendor' }));
  });

  // happy-dom never turns a key into a click, so this checks what the browser obeys: the default prevented.
  it("doesn't take a key still held from the press that raised the nudge as its answer", async () => {
    lists[WED] = [row(1, 'Report'), row(2, 'Email'), row(3, 'Invoices')];
    await renderBoard();
    fireEvent.click(plus('In Progress'));
    enter(field('New priority for today'), 'Call the vendor');
    const add = within(notice()).getByRole('button', { name: WARNING_ACTIONS.fresh.add });
    expect(document.activeElement).toBe(add);
    expect(fireEvent.keyDown(add, { key: 'Enter', repeat: true })).toBe(false);
    expect(fireEvent.keyDown(add, { key: ' ', repeat: true })).toBe(false);
    expect(fireEvent.keyDown(add, { key: 'Enter' })).toBe(true);
  });

  it("drops the question In Progress's box held when its text changes, and asks again on Enter with the new text", async () => {
    lists[WED] = [row(1, 'Report'), row(2, 'Email'), row(3, 'Invoices')];
    await renderBoard();
    fireEvent.click(plus('In Progress'));
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

  it("drops the row In Progress's box held for the nudge when the box closes", async () => {
    lists[WED] = [row(1, 'Report'), row(2, 'Email'), row(3, 'Invoices')];
    await renderBoard();
    fireEvent.click(plus('In Progress'));
    enter(field('New priority for today'), 'Call the vendor');
    expect(within(notice()).getAllByRole('button')).toHaveLength(2);
    fireEvent.keyDown(field('New priority for today'), { key: 'Escape' });
    expect(notice().textContent).toBe('');
    expect(document.activeElement).toBe(plus('In Progress'));
    await settle();
    expect(api.putPriorities).not.toHaveBeenCalled();
    // A pull's question stays when the box closes.
    fireEvent.click(plus('In Progress'));
    fireEvent.change(field('New priority for today'), { target: { value: 'Half typed' } });
    openCard('Follow up');
    moveTo('progress');
    fireEvent.keyDown(field('New priority for today'), { key: 'Escape' });
    expect(within(notice()).getByRole('button', { name: WARNING_ACTIONS.fresh.add })).toBeTruthy();
  });

  it('clears an earlier notice when a row goes in from In Progress below the nudge', async () => {
    await renderBoard();
    openCard('Email');
    moveTo('next');
    expect(notice().textContent).toContain(DONE_STAYS.body);
    fireEvent.click(plus('In Progress'));
    enter(field('New priority for today'), 'Call the vendor');
    expect(notice().textContent).toBe('');
  });
});
