// @vitest-environment happy-dom
import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../api';
import { unlockAudio } from '../../lib/alerts';
import { withItemPatch } from '../../lib/board';
import { BOARD, BOARD_DRAG, DONE_STAYS, PRIORITY_WARNINGS, WARNING_ACTIONS } from '../../lib/copy';
import { deferredAnswer, makeBoard, makeCard, pressKey, QUEUE, settle, stubMatchMedia } from '../../test/hooks';
import type { Board as BoardData, Priority } from '../../types';
import { added, column, dialog, isOpen, moveTo, notice, openCard, putLists, renderBoard, REPORT, row, serveBoard, titlesIn, WED } from './Board.testkit';

vi.mock('../../api');
vi.mock('../../lib/alerts');

let onServer: BoardData;
let lists: Record<string, Priority[]>;
serveBoard({ board: () => onServer, setBoard: (board) => (onServer = board), lists: () => lists, setLists: (fresh) => (lists = fresh) });

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

  it("pulls a task onto today's list by keyboard: Next, then In Progress", async () => {
    await renderBoard();
    await pickUp('Write a KB');
    await press('ArrowRight');
    await press('ArrowRight');
    expect(said()).toBe(BOARD_DRAG.over('Write a KB', 'In Progress'));
    expect(titlesIn('In Progress')).toEqual(['Report', 'Write a KB']);
    await press('Space');
    expect(said()).toBe(BOARD_DRAG.moved('Write a KB', 'In Progress'));
    expect(putLists()).toEqual([{ date: WED, texts: ['Report', 'Email', 'Write a KB'] }]);
    expect(titlesIn('In Progress')).toEqual(['Report', 'Write a KB']);
    // A row of today's now: the focus finds its card there.
    expect(document.activeElement).toBe(card('Write a KB'));
  });

  it('keeps a done row done when it is dropped on Next, and Add a new card puts one where it was dropped', async () => {
    await renderBoard();
    await pickUp('Email');
    expect(said()).toBe(BOARD_DRAG.pickedUp('Email', 'Done'));
    // In Progress and Done don't sort: up and down go nowhere.
    await press('ArrowUp');
    expect(said()).toBe(BOARD_DRAG.pickedUp('Email', 'Done'));
    await press('ArrowLeft');
    await press('ArrowLeft');
    expect(titlesIn('Next')).toEqual(['Email', 'Follow up', 'Plan B']);
    await press('Space');
    expect(said()).toBe(DONE_STAYS.announce('Email', 'Next'));
    expect(titlesIn('Done')).toEqual(['Email', 'Earlier This Week · 2']);
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
    expect(said()).toBe(BOARD_DRAG.pickedUp('Report', 'In Progress'));
    await press('ArrowRight');
    expect(said()).toBe(BOARD_DRAG.over('Report', 'Done'));
    await press('ArrowLeft');
    expect(said()).toBe(BOARD_DRAG.overStart('Report', 'In Progress'));
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
    expect(said()).toBe(BOARD_DRAG.stays('Report', 'In Progress'));
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

  it('drags no item of In Progress or Done below 900 px, where one column shows at a time, while a lane still sorts', async () => {
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
    expect(screen.queryByRole('button', { name: /^Show \d+ More$/ })).toBeNull();
    await press('Escape');
  });

  it("drags a card of Later's Repeats onto today's list, and puts it back with the board notice from Later or Next", async () => {
    onServer = { ...onServer, recurring: [QUEUE] };
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
    // Onto In Progress: today's row, as any pull.
    await pickUp('Monitor the queue');
    await press('ArrowRight');
    await press('ArrowRight');
    expect(said()).toBe(BOARD_DRAG.over('Monitor the queue', 'In Progress'));
    await press('Space');
    expect(putLists()).toEqual([{ date: WED, texts: ['Report', 'Email', 'Monitor the queue'] }]);
    expect(titlesIn('Later')).toEqual(['Write a KB']);
    expect(document.activeElement).toBe(card('Monitor the queue'));
  });

  it("doesn't drag a recurring row, which stays on today's list, and tells how every other card drags and opens", async () => {
    lists[WED] = [row(1, 'Monitor the queue', { uid: QUEUE.uid, recurring: true }), row(2, 'Report')];
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
