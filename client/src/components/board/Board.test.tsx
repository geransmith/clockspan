// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../api';
import { unlockAudio, warnQuietly } from '../../lib/alerts';
import { withCard, withoutCard, withPatch } from '../../lib/board';
import { BOARD, CONFIRM, DONE_STAYS, LOAD_FAILED, PRIORITY_WARNINGS, WARNING_ACTIONS } from '../../lib/copy';
import { apiError, deferred, makeBoard, makeCard, makeDay, makePriority, makeSettings, serveRange, settle, SettingsAndDays } from '../../test/hooks';
import type { Board as BoardData, Priority } from '../../types';
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
/** Whether the page has a mouse or trackpad: the capture box focuses itself and says its keys. */
let finePointer = true;

const row = (position: number, text: string, patch: Partial<Priority> = {}) =>
  makePriority(position, text, { uid: `row${position}`.padEnd(12, '0'), ...patch });

async function renderBoard(settings = makeSettings({ board: true })) {
  vi.mocked(api.getSettings).mockResolvedValue(settings);
  render(
    <SettingsAndDays>
      <Board today={WED} />
    </SettingsAndDays>,
  );
  await settle();
}

/** A column by its heading. */
const column = (name: string) => screen.getByRole('region', { name });
/** The titles a column shows, in order, and Done's fold. */
const titlesIn = (name: string) => [...column(name).querySelectorAll('.board-card-title, .board-earlier')].map((b) => b.textContent);
/** Opens an item's editor by its title. */
const openEditor = (title: string) => fireEvent.click(screen.getByRole('button', { name: title }));
const moveTo = (to: string) => fireEvent.change(screen.getByRole('combobox', { name: 'Move to' }), { target: { value: to } });
const putLists = () => vi.mocked(api.putPriorities).mock.calls.map(([date, list, put]) => ({ date, texts: list.map((p) => p.text), touched: put.touched }));

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  finePointer = true;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(pointer: fine)' && finePointer,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  onServer = makeBoard(
    makeCard('later0000001', 'Write a KB'),
    makeCard('next00000001', 'Follow up', { lane: 'next' }),
    makeCard('planned00001', 'Plan B', { lane: 'next', position: 2, listDate: THU }),
    makeCard('done00000001', 'Shipped', { lane: 'done', doneAt: new Date(2026, 8, 29, 15).getTime() }),
  );
  lists = { [WED]: [row(1, 'Report', { cardUid: 'card00000001' }), row(2, 'Email', { cardUid: 'card00000002', done: true })] };
  vi.mocked(api.getDay).mockImplementation((date) => Promise.resolve(makeDay(date, { priorities: lists[date] ?? [] })));
  serveRange([makeDay(TUE, { priorities: [row(1, 'Tuesday row', { done: true })] }), makeDay(MON)]);
  vi.mocked(api.putPriorities).mockImplementation((date, list) => Promise.resolve({ priorities: (lists[date] = list) }));
  vi.mocked(api.getBoard).mockImplementation(() => Promise.resolve(onServer));
  vi.mocked(api.addCard).mockImplementation((card) => Promise.resolve((onServer = withCard(onServer, card, NOW))));
  vi.mocked(api.patchCard).mockImplementation((uid, { today: _today, ...patch }) => Promise.resolve((onServer = withPatch(onServer, uid, patch))));
  vi.mocked(api.deleteCard).mockImplementation((uid) => Promise.resolve((onServer = withoutCard(onServer, uid))));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Board', () => {
  it("shows Later, Next with the planned card, today's open rows in progress and this week in Done", async () => {
    await renderBoard();
    expect(titlesIn('Later')).toEqual(['Write a KB']);
    expect(titlesIn('Next')).toEqual(['Follow up', 'Plan B']);
    expect(within(column('Next')).getByText('Planned for tomorrow')).toBeTruthy();
    expect(titlesIn('In progress')).toEqual(['Report']);
    expect(titlesIn('Done')).toEqual(['Email', 'Earlier this week · 2']);
    fireEvent.click(screen.getByRole('button', { name: 'Earlier this week · 2' }));
    expect(titlesIn('Done')).toEqual(['Email', 'Earlier this week · 2', 'Shipped', 'Tuesday row']);
    expect(screen.getByRole('button', { name: 'Earlier this week · 2' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('adds a captured card at the top of Later on Enter and at the end of Next on Shift+Enter, keeping the box', async () => {
    await renderBoard();
    const box = screen.getByRole('textbox', { name: 'Add a card' }) as HTMLInputElement;
    expect(document.activeElement).toBe(box);
    expect(screen.getByText('Enter adds to Later, Shift+Enter to Next')).toBeTruthy();
    fireEvent.change(box, { target: { value: '  Look into the export  ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.change(box, { target: { value: 'Call the vendor' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    // A blank box adds nothing.
    fireEvent.keyDown(box, { key: 'Enter' });
    await settle();
    expect(vi.mocked(api.addCard).mock.calls.map(([c]) => [c.title, c.categoryUid, c.lane, c.before])).toEqual([
      ['Look into the export', null, 'later', 'later0000001'],
      ['Call the vendor', null, 'next', null],
    ]);
    expect(box.value).toBe('');
    expect(document.activeElement).toBe(box);
    expect(titlesIn('Later')).toEqual(['Look into the export', 'Write a KB']);
    // Plan B sits in Next at its place: planned for tomorrow, not moved.
    expect(titlesIn('Next')).toEqual(['Follow up', 'Plan B', 'Call the vendor']);
    // The button adds to Later too, and gives the focus back to the box.
    fireEvent.change(box, { target: { value: 'One more' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to Later' }));
    expect(document.activeElement).toBe(box);
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(document.activeElement).not.toBe(box);
  });

  it('leaves the focus alone and the keys unsaid on a touch screen, and stops capture at the cap', async () => {
    finePointer = false;
    onServer = makeBoard(...Array.from({ length: 300 }, (_, i) => makeCard(`c${i}`.padEnd(12, '0'), `Card ${i}`, { position: i + 1 })));
    await renderBoard();
    const box = screen.getByRole('textbox', { name: 'Add a card' });
    expect(document.activeElement).not.toBe(box);
    expect(screen.queryByText('Enter adds to Later, Shift+Enter to Next')).toBeNull();
    expect((box as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(BOARD.full)).toBeTruthy();
  });

  it('moves a card between Later and Next with Move to', async () => {
    await renderBoard();
    openEditor('Write a KB');
    expect(
      within(screen.getByRole('combobox', { name: 'Move to' }))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Pick a column', 'Next', 'In progress', 'Done']);
    moveTo('next');
    await settle();
    expect(api.patchCard).toHaveBeenCalledExactlyOnceWith('later0000001', { today: WED, lane: 'next', before: null });
    expect(titlesIn('Next')).toEqual(['Follow up', 'Plan B', 'Write a KB']);
  });

  it("pulls a card into In progress as a row of today's list, with the card as touched", async () => {
    await renderBoard();
    openEditor('Follow up');
    moveTo('progress');
    await settle();
    expect(putLists()).toEqual([{ date: WED, texts: ['Report', 'Email', 'Follow up'], touched: ['next00000001'] }]);
    expect(titlesIn('In progress')).toEqual(['Report', 'Follow up']);
  });

  it('puts a Next card in Done as a ticked row of today, unlocking the sound in the tap', async () => {
    await renderBoard();
    openEditor('Follow up');
    moveTo('done');
    expect(unlockAudio).toHaveBeenCalledTimes(1);
    await settle();
    expect(lists[WED]![2]).toMatchObject({ text: 'Follow up', done: true, cardUid: 'next00000001' });
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
    expect(putLists()).toEqual([{ date: WED, texts: ['Report', 'Email', ''], touched: ['card00000001'] }]);
    expect(lists[WED]![0]!.done).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Email done' }));
    await settle();
    expect(lists[WED]![1]!.done).toBe(false);
    expect(unlockAudio).toHaveBeenCalledTimes(1);
  });

  it('sends a Done card off today back to Next when it is unticked', async () => {
    await renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Earlier this week · 2' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Shipped done' }));
    await settle();
    expect(api.patchCard).toHaveBeenCalledExactlyOnceWith('done00000001', { today: WED, lane: 'next' });
  });

  it("parks today's row: its card placed in Later first, then the row off today's list", async () => {
    await renderBoard();
    openEditor('Report');
    moveTo('later');
    await settle();
    expect(api.addCard).toHaveBeenCalledExactlyOnceWith({ uid: 'card00000001', title: 'Report', categoryUid: null, lane: 'later', before: 'later0000001' });
    expect(putLists()).toEqual([{ date: WED, texts: ['Email', ''], touched: ['card00000001'] }]);
    expect(vi.mocked(api.addCard).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.putPriorities).mock.invocationCallOrder[0]!);
    expect(titlesIn('Later')).toEqual(['Report', 'Write a KB']);
    expect(titlesIn('In progress')).toEqual([]);
    expect(screen.getByText("Nothing open on today's list.")).toBeTruthy();
  });

  it('puts the focus on the moved item once it lands, when the move left it nowhere', async () => {
    finePointer = false;
    await renderBoard();
    openEditor('Report');
    // The select goes with the editor, and the focus with it.
    screen.getByRole('combobox', { name: 'Move to' }).focus();
    moveTo('later');
    await settle();
    expect(titlesIn('Later')).toEqual(['Report', 'Write a KB']);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Report' }));
  });

  it('leaves the focus where the user put it while a park was on its way', async () => {
    const placed = deferred<BoardData>();
    vi.mocked(api.addCard).mockReturnValueOnce(placed.promise);
    await renderBoard();
    openEditor('Report');
    moveTo('later');
    const box = screen.getByRole('textbox', { name: 'Add a card' });
    box.focus();
    placed.resolve((onServer = withCard(onServer, { uid: 'card00000001', title: 'Report', categoryUid: null, lane: 'later', before: 'later0000001' }, NOW)));
    await settle();
    expect(titlesIn('Later')).toEqual(['Report', 'Write a KB']);
    expect(document.activeElement).toBe(box);
  });

  it('holds a pull onto a list already at the nudge until Add anyway, and Keep it short sends nothing', async () => {
    lists[WED] = [row(1, 'Report', { cardUid: 'card00000001' }), row(2, 'Email', { cardUid: 'card00000002' }), row(3, 'Invoices', { cardUid: 'card00000003' })];
    await renderBoard();
    openEditor('Follow up');
    moveTo('progress');
    const notice = screen.getByRole('status');
    expect(PRIORITY_WARNINGS.fresh).toContain(within(notice).getByText(/./, { selector: 'span:not(.notice-actions)' }).textContent);
    fireEvent.click(within(notice).getByRole('button', { name: WARNING_ACTIONS.fresh.keep }));
    await settle();
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(within(screen.getByRole('status')).queryByRole('button')).toBeNull();
    // The editor stays open behind a notice, and the next move replaces it.
    moveTo('progress');
    fireEvent.click(within(screen.getByRole('status')).getByRole('button', { name: WARNING_ACTIONS.fresh.add }));
    await settle();
    expect(putLists()[0]!.texts).toEqual(['Report', 'Email', 'Invoices', 'Follow up']);
    // A drop into Done asks nothing.
    openEditor('Write a KB');
    moveTo('done');
    await settle();
    expect(api.putPriorities).toHaveBeenCalledTimes(2);
  });

  describe('a done item moved to Later or Next', () => {
    it('stays done: the notice says so and sends nothing', async () => {
      await renderBoard();
      openEditor('Email');
      moveTo('next');
      const notice = screen.getByRole('status');
      expect(notice.textContent).toContain(DONE_STAYS.title('Email'));
      expect(notice.textContent).toContain(DONE_STAYS.body);
      // The notice takes the focus, so a keyboard user reaches its buttons.
      expect(document.activeElement).toBe(within(notice).getByRole('button', { name: DONE_STAYS.add('Next') }));
      await settle();
      expect(api.putPriorities).not.toHaveBeenCalled();
      expect(api.addCard).not.toHaveBeenCalled();
      expect(api.patchCard).not.toHaveBeenCalled();
    });

    it('Add a new card posts a fresh card with the same title and category in that lane, and the item stays done', async () => {
      lists[WED]![1] = { ...lists[WED]![1]!, categoryUid: 'cafe00000001' };
      await renderBoard();
      openEditor('Email');
      moveTo('next');
      fireEvent.click(screen.getByRole('button', { name: DONE_STAYS.add('Next') }));
      await settle();
      expect(api.addCard).toHaveBeenCalledTimes(1);
      const { uid, ...card } = vi.mocked(api.addCard).mock.calls[0]![0];
      expect(card).toEqual({ title: 'Email', categoryUid: 'cafe00000001', lane: 'next', before: null });
      // A card of its own, not the done row's.
      expect(uid).toMatch(/^[0-9a-f]{12}$/);
      expect(uid).not.toBe('card00000002');
      expect(titlesIn('Done')).toContain('Email');
      expect(titlesIn('Next')).toEqual(['Follow up', 'Plan B', 'Email']);
      // Later's new card goes at the top, as capture puts one.
      fireEvent.click(screen.getByRole('button', { name: 'Earlier this week · 2' }));
      openEditor('Shipped');
      moveTo('later');
      fireEvent.click(screen.getByRole('button', { name: DONE_STAYS.add('Later') }));
      await settle();
      expect(vi.mocked(api.addCard).mock.lastCall![0]).toMatchObject({ title: 'Shipped', lane: 'later', before: 'later0000001' });
    });

    it('Leave it and Escape close the notice, send nothing and put the focus back on the item', async () => {
      await renderBoard();
      openEditor('Email');
      moveTo('later');
      fireEvent.click(screen.getByRole('button', { name: DONE_STAYS.leave }));
      expect(within(screen.getByRole('status')).queryByRole('button')).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Email' }));
      moveTo('next');
      fireEvent.keyDown(screen.getByRole('button', { name: DONE_STAYS.leave }), { key: 'Escape' });
      expect(within(screen.getByRole('status')).queryByRole('button')).toBeNull();
      await settle();
      expect(api.addCard).not.toHaveBeenCalled();
    });
  });

  it("offers a recurring row no Later or Next, only Remove from today, which takes it off today's list", async () => {
    lists[WED] = [row(1, 'Monitor the queue', { recurringUid: 'rec000000001' })];
    await renderBoard();
    openEditor('Monitor the queue');
    expect(
      within(screen.getByRole('combobox', { name: 'Move to' }))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Pick a column', 'Done']);
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove from today' }));
    await settle();
    expect(putLists()).toEqual([{ date: WED, texts: ['', ''], touched: undefined }]);
    expect(api.deleteCard).not.toHaveBeenCalled();
  });

  it('offers a planned card Delete only, with a confirm that names its day', async () => {
    lists[THU] = [row(1, 'Plan B', { cardUid: 'planned00001' })];
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    await renderBoard();
    openEditor('Plan B');
    expect(screen.queryByRole('combobox', { name: 'Move to' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Title' })).toBeNull();
    expect(screen.getByText("Change it on that day's sheet.")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(confirm).toHaveBeenCalledWith(CONFIRM.deleteCard(['tomorrow']));
    await settle();
    expect(putLists()).toEqual([{ date: THU, texts: ['', ''], touched: undefined }]);
    expect(api.deleteCard).toHaveBeenCalledExactlyOnceWith('planned00001');
    expect(titlesIn('Next')).toEqual(['Follow up']);
  });

  it("deletes today's row and the card with a confirm naming today and the later day, and nothing when the confirm is turned down", async () => {
    onServer = makeBoard(...onServer.cards, makeCard('card00000001', 'Report', { lane: 'next', position: 3, listDate: THU }));
    lists[THU] = [row(1, 'Report', { cardUid: 'card00000001' })];
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    await renderBoard();
    openEditor('Report');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(confirm).toHaveBeenCalledWith(CONFIRM.deleteCard(['today', 'tomorrow']));
    await settle();
    expect(api.putPriorities).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await settle();
    expect(putLists().map((p) => [p.date, p.texts])).toEqual([
      [WED, ['Email', '']],
      [THU, ['', '']],
    ]);
    expect(api.deleteCard).toHaveBeenCalledExactlyOnceWith('card00000001');
  });

  it("refuses to park today's row whose card a later day holds in Later, and parks it in Next", async () => {
    onServer = makeBoard(...onServer.cards, makeCard('card00000001', 'Report', { lane: 'next', position: 3, listDate: THU }));
    await renderBoard();
    openEditor('Report');
    moveTo('later');
    expect(screen.getByRole('status').textContent).toContain(BOARD.planned('Report', 'tomorrow'));
    fireEvent.click(screen.getByRole('button', { name: BOARD.close }));
    expect(screen.getByRole('status').textContent).toBe('');
    moveTo('next');
    await settle();
    expect(api.addCard).toHaveBeenCalledExactlyOnceWith({ uid: 'card00000001', title: 'Report', categoryUid: null, lane: 'next', before: null });
  });

  it('offers no Delete on a Done card off today, whose ticked row an earlier day keeps: its untick is the way back', async () => {
    await renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Earlier this week · 2' }));
    openEditor('Shipped');
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Move to' })).toBeTruthy();
    // Today's ticked row keeps its Delete.
    openEditor('Email');
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
  });

  it('renames a card or a row of today from the editor, and Escape puts the title back', async () => {
    await renderBoard();
    openEditor('Write a KB');
    const title = screen.getByRole('textbox', { name: 'Title' });
    fireEvent.change(title, { target: { value: 'Write the SSO KB' } });
    // Enter saves once and closes the editor, with the focus back on the title; the blur that
    // moving the focus brings saves nothing more.
    fireEvent.keyDown(title, { key: 'Enter' });
    fireEvent.blur(title);
    await settle();
    expect(api.patchCard).toHaveBeenCalledExactlyOnceWith('later0000001', { today: WED, title: 'Write the SSO KB' });
    expect(screen.queryByRole('textbox', { name: 'Title' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Write the SSO KB' }));

    openEditor('Report');
    const rowTitle = screen.getByRole('textbox', { name: 'Title' });
    fireEvent.change(rowTitle, { target: { value: 'Not this' } });
    fireEvent.keyDown(rowTitle, { key: 'Escape' });
    fireEvent.blur(rowTitle);
    await settle();
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Report' }));

    openEditor('Report');
    const again = screen.getByRole('textbox', { name: 'Title' });
    fireEvent.change(again, { target: { value: 'Report v2' } });
    fireEvent.blur(again);
    await settle();
    expect(putLists()).toEqual([{ date: WED, texts: ['Report v2', 'Email', ''], touched: ['card00000001'] }]);
  });

  it('says a move the store turned down in a banner', async () => {
    await renderBoard();
    vi.mocked(api.patchCard).mockRejectedValueOnce(new Error('offline'));
    openEditor('Write a KB');
    moveTo('next');
    await settle();
    expect(warnQuietly).toHaveBeenCalledWith(expect.objectContaining({ tag: 'save-failed' }));
    expect(titlesIn('Later')).toEqual(['Write a KB']);
  });

  it("says why in the banner when the store refuses a move: another device's change, or a full list", async () => {
    await renderBoard();
    vi.mocked(api.patchCard).mockRejectedValueOnce(apiError(409));
    openEditor('Write a KB');
    moveTo('next');
    await settle();
    expect(warnQuietly).toHaveBeenCalledWith({ title: BOARD.stale, tag: 'board-move' });
    expect(titlesIn('Later')).toEqual(['Write a KB']);
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
    const shown = () => [...document.querySelectorAll('.board-col[data-shown]')].map((c) => c.querySelector('h2')!.textContent);
    expect(shown()).toEqual(['In progress']);
    fireEvent.click(within(screen.getByRole('group', { name: 'Board column' })).getByRole('button', { name: 'Later' }));
    expect(shown()).toEqual(['Later']);
  });

  it('shows a Try again for a board that could not be read', async () => {
    vi.mocked(api.getBoard).mockRejectedValue(new Error('offline'));
    await renderBoard();
    expect(screen.getByText(/Could not load the board/)).toBeTruthy();
    vi.mocked(api.getBoard).mockImplementation(() => Promise.resolve(onServer));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();
    expect(titlesIn('Later')).toEqual(['Write a KB']);
  });
});
