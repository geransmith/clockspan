// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../api';
import { unlockAudio, warnQuietly } from '../../lib/alerts';
import { withCard, withCategory, withoutCard, withPatch } from '../../lib/board';
import { BOARD, BOARD_DRAG, CONFIRM, DONE_STAYS, LOAD_FAILED, PRIORITY_WARNINGS, WARNING_ACTIONS } from '../../lib/copy';
import {
  apiError,
  deferred,
  makeBoard,
  makeCard,
  makeCategory,
  makeDay,
  makePriority,
  makeSettings,
  serveRange,
  settle,
  SettingsAndDays,
} from '../../test/hooks';
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
/** The board notice's live region (drag and drop has a live region of its own). */
const notice = () => document.querySelector<HTMLElement>('.board-notice[role="status"]')!;
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
    const box = notice();
    expect(PRIORITY_WARNINGS.fresh).toContain(within(box).getByText(/./, { selector: 'span:not(.notice-actions)' }).textContent);
    fireEvent.click(within(box).getByRole('button', { name: WARNING_ACTIONS.fresh.keep }));
    await settle();
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(within(notice()).queryByRole('button')).toBeNull();
    // The editor stays open behind a notice, and the next move replaces it.
    moveTo('progress');
    fireEvent.click(within(notice()).getByRole('button', { name: WARNING_ACTIONS.fresh.add }));
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
      const box = notice();
      expect(box.textContent).toContain(DONE_STAYS.title('Email'));
      expect(box.textContent).toContain(DONE_STAYS.body);
      // A task that keeps coming back has a better home than a new card each time.
      expect(box.textContent).toContain('make it a recurring priority in Settings → Board');
      // The notice takes the focus, so a keyboard user reaches its buttons.
      expect(document.activeElement).toBe(within(box).getByRole('button', { name: DONE_STAYS.add('Next') }));
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

    it("Leave it and Escape close the notice, send nothing and put the focus back on the item's grip, or its title where the grip takes none", async () => {
      await renderBoard();
      openEditor('Email');
      moveTo('later');
      fireEvent.click(screen.getByRole('button', { name: DONE_STAYS.leave }));
      expect(within(notice()).queryByRole('button')).toBeNull();
      const grip = screen.getByRole('button', { name: 'Drag to move Email' }) as HTMLButtonElement;
      expect(document.activeElement).toBe(grip);
      // A grip hidden on a phone takes no focus, as a disabled one doesn't here.
      grip.disabled = true;
      moveTo('next');
      fireEvent.keyDown(screen.getByRole('button', { name: DONE_STAYS.leave }), { key: 'Escape' });
      expect(within(notice()).queryByRole('button')).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Email' }));
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

  it("shows a recurring row's title as text, renamed in Settings, and keeps its chip, its tick and Remove from today", async () => {
    lists[WED] = [row(1, 'Monitor the queue', { recurringUid: 'rec000000001' }), row(2, 'Report', { cardUid: 'card00000001' })];
    await renderBoard();
    openEditor('Monitor the queue');
    const editor = column('In progress').querySelector<HTMLElement>('.board-editor')!;
    expect(within(editor).queryByRole('textbox', { name: 'Title' })).toBeNull();
    expect(editor.querySelector('.board-editor-title')?.textContent).toBe('Monitor the queue');
    expect(within(editor).getByText('Rename it in Settings → Board.')).toBeTruthy();
    expect(within(editor).getByRole('button', { name: 'Category for Monitor the queue: none' })).toBeTruthy();
    expect(within(editor).getByRole('button', { name: 'Remove from today' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Monitor the queue done' })).toBeTruthy();
    // A row with a card is still renamed in place, with no line about Settings.
    openEditor('Report');
    expect(screen.getByRole('textbox', { name: 'Title' })).toBeTruthy();
    expect(screen.queryByText('Rename it in Settings → Board.')).toBeNull();
  });

  it('marks a recurring row on its meta line, and only that row', async () => {
    lists[WED] = [row(1, 'Monitor the queue', { recurringUid: 'rec000000001' }), row(2, 'Report', { cardUid: 'card00000001' })];
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
    expect(notice().textContent).toContain(BOARD.planned('Report', 'tomorrow'));
    fireEvent.click(screen.getByRole('button', { name: BOARD.close }));
    expect(notice().textContent).toBe('');
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

  const grip = (title: string) => screen.getByRole('button', { name: `Drag to move ${title}` });
  /** What dnd-kit's live region last said. */
  const said = () => document.querySelector('[id^="DndLiveRegion"]')!.textContent;
  async function press(code: string, target: Element | Document = document) {
    fireEvent.keyDown(target, { code });
    await settle();
  }
  /** Space on the item's grip, as a keyboard user picks it up. */
  async function pickUp(title: string) {
    grip(title).focus();
    await press('Space', grip(title));
  }

  it('moves a card into the next lane by keyboard, before the card it lands on, saying what happens and keeping the focus on its grip', async () => {
    await renderBoard();
    await pickUp('Write a KB');
    expect(said()).toBe(BOARD_DRAG.pickedUp('Write a KB', 'Later'));
    await press('ArrowRight');
    expect(said()).toBe(BOARD_DRAG.overBefore('Write a KB', 'Next', 'Follow up'));
    // It shows where it would land, in a column marked as the one it is over.
    expect(titlesIn('Next')).toEqual(['Write a KB', 'Follow up', 'Plan B']);
    expect(column('Next').hasAttribute('data-over')).toBe(true);
    await press('Space');
    expect(api.patchCard).toHaveBeenCalledExactlyOnceWith('later0000001', { today: WED, lane: 'next', before: 'next00000001' });
    expect(said()).toBe(BOARD_DRAG.moved('Write a KB', 'Next'));
    expect(titlesIn('Next')).toEqual(['Write a KB', 'Follow up', 'Plan B']);
    expect(column('Next').hasAttribute('data-over')).toBe(false);
    expect(document.activeElement).toBe(grip('Write a KB'));
  });

  it('sorts a card within its lane by keyboard', async () => {
    onServer = makeBoard(...onServer.cards, makeCard('later0000002', 'Call the vendor', { position: 2 }));
    await renderBoard();
    await pickUp('Write a KB');
    await press('ArrowDown');
    expect(said()).toBe(BOARD_DRAG.overEnd('Write a KB', 'Later'));
    await press('Space');
    expect(api.patchCard).toHaveBeenCalledExactlyOnceWith('later0000001', { today: WED, before: null });
    expect(titlesIn('Later')).toEqual(['Call the vendor', 'Write a KB']);
  });

  it("pulls a card onto today's list by keyboard: Next, then In progress", async () => {
    await renderBoard();
    await pickUp('Write a KB');
    await press('ArrowRight');
    await press('ArrowRight');
    expect(said()).toBe(BOARD_DRAG.over('Write a KB', 'In progress'));
    expect(titlesIn('In progress')).toEqual(['Report', 'Write a KB']);
    await press('Space');
    expect(said()).toBe(BOARD_DRAG.moved('Write a KB', 'In progress'));
    expect(putLists()).toEqual([{ date: WED, texts: ['Report', 'Email', 'Write a KB'], touched: ['later0000001'] }]);
    expect(titlesIn('In progress')).toEqual(['Report', 'Write a KB']);
    // A row of today's now, under a new id: the focus finds its grip there.
    expect(document.activeElement).toBe(grip('Write a KB'));
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
    expect(vi.mocked(api.addCard).mock.calls.map(([c]) => [c.title, c.lane, c.before])).toEqual([['Email', 'next', 'next00000001']]);
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

  it('puts the item back on Escape, sending nothing', async () => {
    await renderBoard();
    await pickUp('Write a KB');
    await press('ArrowRight');
    await press('Escape');
    expect(said()).toBe(BOARD_DRAG.cancelled('Write a KB', 'Later'));
    expect(titlesIn('Later')).toEqual(['Write a KB']);
    expect(titlesIn('Next')).toEqual(['Follow up', 'Plan B']);
    expect(document.activeElement).toBe(grip('Write a KB'));
    await settle();
    expect(api.patchCard).not.toHaveBeenCalled();
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
    fireEvent.pointerDown(grip('Report'), { isPrimary: true, button: 0, clientX: 640, clientY: 270 });
    fireEvent.pointerMove(document, { isPrimary: true, clientX: 700, clientY: 280 });
    await settle();
    fireEvent.pointerMove(document, { isPrimary: true, clientX: 960, clientY: 400 });
    await settle();
    expect(said()).toBe(BOARD_DRAG.over('Report', 'Done'));
    fireEvent.pointerUp(document, { isPrimary: true, clientX: 960, clientY: 400 });
    expect(unlockAudio).toHaveBeenCalledTimes(1);
    // dnd-kit keeps a click guard on the document for 50 ms after a pointer drag, which would
    // swallow the next test's clicks.
    await settle(50);
    expect(putLists()).toEqual([{ date: WED, texts: ['Report', 'Email', ''], touched: ['card00000001'] }]);
    expect(lists[WED]![0]!.done).toBe(true);
  });

  it('holds a pull onto a full list with the nudge, as Move to does', async () => {
    lists[WED] = [row(1, 'Report', { cardUid: 'card00000001' }), row(2, 'Email', { cardUid: 'card00000002' }), row(3, 'Invoices', { cardUid: 'card00000003' })];
    await renderBoard();
    await pickUp('Follow up');
    await press('ArrowRight');
    await press('Space');
    expect(PRIORITY_WARNINGS.fresh).toContain(said());
    const add = within(notice()).getByRole('button', { name: WARNING_ACTIONS.fresh.add });
    expect(document.activeElement).toBe(add);
    await settle();
    expect(api.putPriorities).not.toHaveBeenCalled();
    // Add anyway goes with the notice: the focus goes to the grip of the row the card became.
    fireEvent.click(add);
    await settle();
    expect(putLists()[0]!.texts).toEqual(['Report', 'Email', 'Invoices', 'Follow up']);
    expect(document.activeElement).toBe(grip('Follow up'));
  });

  it("doesn't pick up an item whose move is on its way until the move lands", async () => {
    const placed = deferred<BoardData>();
    vi.mocked(api.addCard).mockReturnValueOnce(placed.promise);
    await renderBoard();
    openEditor('Report');
    moveTo('later');
    // Today's row shows in Later while its park waits on the board's answer, with its grip held.
    expect(titlesIn('Later')).toEqual(['Report', 'Write a KB']);
    expect(grip('Report').getAttribute('aria-disabled')).toBe('true');
    await pickUp('Report');
    expect(said()).toBe('');
    placed.resolve((onServer = withCard(onServer, { uid: 'card00000001', title: 'Report', categoryUid: null, lane: 'later', before: 'later0000001' }, NOW)));
    await settle();
    expect(grip('Report').getAttribute('aria-disabled')).toBe('false');
    await pickUp('Report');
    expect(said()).toBe(BOARD_DRAG.pickedUp('Report', 'Later'));
    await press('Escape');
  });

  it("keeps Later's fold as it was while a card dragged in makes it ten", async () => {
    const later = Array.from({ length: 9 }, (_, i) => makeCard(`later${i}`.padEnd(12, '0'), `Later ${i}`, { position: i + 1 }));
    onServer = makeBoard(...later, makeCard('next00000001', 'Follow up', { lane: 'next' }));
    await renderBoard();
    await pickUp('Follow up');
    await press('ArrowLeft');
    expect(titlesIn('Later')).toHaveLength(10);
    expect(screen.queryByRole('button', { name: /^Show all/ })).toBeNull();
    await press('Escape');
  });

  it('gives no grip to a planned card or a recurring row, which stay where their lists put them', async () => {
    lists[WED] = [row(1, 'Monitor the queue', { recurringUid: 'rec000000001' }), row(2, 'Report', { cardUid: 'card00000001' })];
    await renderBoard();
    expect(screen.queryByRole('button', { name: 'Drag to move Plan B' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Drag to move Monitor the queue' })).toBeNull();
    expect(grip('Follow up')).toBeTruthy();
    expect(grip('Report')).toBeTruthy();
  });
});

describe('categories', () => {
  const TICKETS = makeCategory('cat000000001', 'Tickets');
  const ADMIN = makeCategory('cat000000002', 'Admin', { color: 'teal' });
  const OLD = makeCategory('cat000000003', 'Old work', { color: 'gold', archived: true });
  const captureChip = () => screen.getByRole('button', { name: /^Category for new cards: / });
  const pickOption = (name: string) => fireEvent.click(screen.getByRole('option', { name }));
  const capture = (title: string) => {
    const box = screen.getByRole('textbox', { name: 'Add a card' });
    fireEvent.change(box, { target: { value: title } });
    fireEvent.keyDown(box, { key: 'Enter' });
  };
  const sentCategories = () => vi.mocked(api.addCard).mock.calls.map(([c]) => c.categoryUid);

  beforeEach(() => {
    localStorage.clear();
    onServer = {
      ...makeBoard(makeCard('later0000001', 'Write a KB', { categoryUid: TICKETS.uid }), makeCard('planned00001', 'Plan B', { lane: 'next', listDate: THU })),
      categories: [TICKETS, ADMIN, OLD],
    };
    lists[WED] = [row(1, 'Report', { cardUid: 'card00000001', categoryUid: OLD.uid })];
    vi.mocked(api.addCategory).mockImplementation((c) => Promise.resolve((onServer = withCategory(onServer, c))));
  });

  it("shows each item's category on its meta line, a removed one included", async () => {
    await renderBoard();
    const meta = (name: string) => [...column(name).querySelectorAll('.board-card-meta')];
    expect(meta('Later').map((m) => m.textContent)).toEqual(['Tickets']);
    expect(meta('Later')[0]!.querySelector('.cat-dot')?.getAttribute('data-color')).toBe('blue');
    expect(meta('In progress').map((m) => m.textContent)).toEqual(['Old work']);
    // A card with none has no meta line, and a planned one says when.
    expect(meta('Next').map((m) => m.textContent)).toEqual(['Planned for tomorrow']);
  });

  it("puts a recurring row's mark after its category", async () => {
    lists[WED] = [row(1, 'Monitor the queue', { recurringUid: 'rec000000001', categoryUid: TICKETS.uid })];
    await renderBoard();
    const meta = column('In progress').querySelector('.board-card-meta')!;
    expect([...meta.children].map((c) => c.className)).toEqual(['board-card-category', 'repeat-mark']);
    expect(meta.textContent).toBe('Tickets');
  });

  it("sends a new card in the capture box's category, remembered on this device", async () => {
    await renderBoard();
    expect(captureChip().textContent).toBe('Category');
    fireEvent.click(captureChip());
    pickOption('Admin');
    expect(localStorage.getItem('focus:capture-category')).toBe(ADMIN.uid);
    capture('Call the vendor');
    capture('Order cables');
    await settle();
    expect(sentCategories()).toEqual([ADMIN.uid, ADMIN.uid]);

    cleanup();
    await renderBoard();
    expect(captureChip().getAttribute('aria-label')).toBe('Category for new cards: Admin');
    fireEvent.click(captureChip());
    pickOption('No category');
    expect(localStorage.getItem('focus:capture-category')).toBe('');
    capture('No category this time');
    await settle();
    expect(sentCategories()).toEqual([ADMIN.uid, ADMIN.uid, null]);
  });

  it('reads a remembered category that was removed, or that the board lacks, as none', async () => {
    localStorage.setItem('focus:capture-category', OLD.uid);
    await renderBoard();
    expect(captureChip().getAttribute('aria-label')).toBe('Category for new cards: none');
    capture('A card');
    await settle();
    expect(sentCategories()).toEqual([null]);
  });

  it("makes a category from the capture chip's New category, in the next colour, and uses it at once", async () => {
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
    expect(warnQuietly).toHaveBeenCalledWith(expect.objectContaining({ tag: 'save-failed' }));
    expect(captureChip().getAttribute('aria-label')).toBe('Category for new cards: none');
  });

  it("sets a row of today's category through the row, with its card as touched, and a card's on the card", async () => {
    await renderBoard();
    openEditor('Report');
    fireEvent.click(screen.getByRole('button', { name: 'Category for Report: Old work' }));
    pickOption('Tickets');
    await settle();
    expect(putLists()).toEqual([{ date: WED, texts: ['Report', '', ''], touched: ['card00000001'] }]);
    expect(lists[WED]![0]!.categoryUid).toBe(TICKETS.uid);

    openEditor('Write a KB');
    fireEvent.click(screen.getByRole('button', { name: 'Category for Write a KB: Tickets' }));
    pickOption('Admin');
    await settle();
    expect(api.patchCard).toHaveBeenCalledExactlyOnceWith('later0000001', { today: WED, categoryUid: ADMIN.uid });
    expect(column('Later').querySelector('.board-card-meta')?.textContent).toBe('Admin');
    // The editor stays open, its chip on the new category.
    expect(screen.getByRole('button', { name: 'Category for Write a KB: Admin' })).toBe(document.activeElement);
  });

  it("offers no chip for a planned card or an earlier day's row", async () => {
    await renderBoard();
    openEditor('Plan B');
    expect(screen.queryByRole('button', { name: /^Category for Plan B/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Earlier this week · 1' }));
    openEditor('Tuesday row');
    expect(screen.queryByRole('button', { name: /^Category for Tuesday row/ })).toBeNull();
  });
});
