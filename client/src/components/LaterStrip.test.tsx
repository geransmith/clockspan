// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { BOARD_LIMITS } from '../../../shared/api.js';
import { warnQuietly, warnSaveFailed } from '../lib/alerts';
import { withItem } from '../lib/board';
import { BOARD, LATER_ADDED, SAVE_FAILED } from '../lib/copy';
import { USER_KEYS } from '../lib/storage';
import { ADMIN, answered, deferredAnswer, makeBoard, makeCard, settle, SettingsAndDays, TICKETS } from '../test/hooks';
import type { Board } from '../types';
import { LaterStrip } from './LaterStrip';

vi.mock('../api');
vi.mock('../lib/alerts');

/** App's part: whether the strip is open, and the header's Add to Later, which opens it with the focus in its box. */
function Shell({ hidden }: { hidden: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        id="header-later"
        onClick={() => {
          flushSync(() => setOpen(true));
          box.current?.focus();
        }}
      >
        Add to Later
      </button>
      <button>Elsewhere</button>
      {open && <LaterStrip hidden={hidden} inputRef={box} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Renders the strip, opened from the header once the board has loaded; the answer hides it (the Board) or shows it again. */
async function renderStrip({ strict = false } = {}) {
  const page = (hidden: boolean) => {
    const tree = (
      <SettingsAndDays>
        <Shell hidden={hidden} />
      </SettingsAndDays>
    );
    return strict ? <StrictMode>{tree}</StrictMode> : tree;
  };
  const { rerender } = render(page(false));
  await settle();
  openStrip();
  return (hidden: boolean) => rerender(page(hidden));
}

const header = () => document.getElementById('header-later')!;
const openStrip = () => fireEvent.click(header());
const isOpen = () => document.getElementById('later-strip') !== null;
// By the DOM, since a hidden strip is out of the accessibility tree.
const field = () => document.querySelector<HTMLInputElement>('#later-strip input')!;
const status = () => document.querySelector('#later-strip [role="status"]')!.textContent;
const error = () => document.getElementById('later-strip-error')?.textContent ?? null;
const type = (text: string) => fireEvent.change(field(), { target: { value: text } });
const enter = (text: string) => {
  type(text);
  fireEvent.keyDown(field(), { key: 'Enter' });
};
const fail = () => Promise.reject(new Error('offline'));

let onServer: Board;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  onServer = {
    ...makeBoard(makeCard('second000001', 'Second', { position: 2 }), makeCard('next00000001', 'Next', { lane: 'next' }), makeCard('first0000001', 'First')),
    categories: [TICKETS, ADMIN],
  };
  vi.mocked(api.getBoard).mockImplementation(() => Promise.resolve(answered(onServer)));
  vi.mocked(api.addItem).mockImplementation((item) => Promise.resolve(answered((onServer = withItem(onServer, item, 0)))));
});

describe('LaterStrip', () => {
  it("puts a card at the top of Later in the chip's category, keeping the box open, and says so once the save answers", async () => {
    localStorage.setItem(USER_KEYS.captureCategory, TICKETS.uid);
    const answer = deferredAnswer<Board>();
    vi.mocked(api.addItem).mockReturnValueOnce(answer.promise);
    await renderStrip();
    expect(screen.getByRole('group', { name: 'Add to Later' })).toBeTruthy();
    expect(document.activeElement).toBe(field());
    expect([field().placeholder, field().getAttribute('aria-label')]).toEqual(['Park a thought in Later', 'New card for Later']);
    enter('  Call the vendor back  ');
    expect(field().value).toBe('');
    expect(document.activeElement).toBe(field());
    await settle();
    expect(vi.mocked(api.addItem).mock.calls.map(([c]) => [c.title, c.categoryUid, c.lane, c.before])).toEqual([
      ['Call the vendor back', TICKETS.uid, 'later', 'first0000001'],
    ]);
    expect(status()).toBe('');
    answer.resolve(withItem(onServer, vi.mocked(api.addItem).mock.calls[0]![0], 0));
    await settle();
    expect(status()).toBe(LATER_ADDED('Call the vendor back'));
    expect(isOpen()).toBe(true);
    // The next goes above it, the top of Later as shown.
    enter('Order cables');
    await settle();
    expect(vi.mocked(api.addItem).mock.calls[1]![0].before).toBe(vi.mocked(api.addItem).mock.calls[0]![0].uid);
    expect(status()).toBe(LATER_ADDED('Order cables'));
  });

  it('closes on an empty Enter, Escape and ×, with the focus back on Add to Later and the page left where it was, and Escape and × drop the text', async () => {
    await renderStrip();
    const focus = vi.spyOn(header(), 'focus');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(header());
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    const closes = [() => fireEvent.keyDown(field(), { key: 'Escape' }), () => fireEvent.click(screen.getByRole('button', { name: 'Close' }))];
    for (const close of closes) {
      openStrip();
      type('Half a thought');
      focus.mockClear();
      close();
      expect(isOpen()).toBe(false);
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(document.activeElement).toBe(header());
      openStrip();
      expect(field().value).toBe('');
      fireEvent.keyDown(field(), { key: 'Enter' });
    }
    // Pressed, × leaves the focus in the box, so an empty box doesn't close through its blur first.
    openStrip();
    expect(fireEvent.mouseDown(screen.getByRole('button', { name: 'Close' }))).toBe(false);
    await settle();
    expect(api.addItem).not.toHaveBeenCalled();
  });

  it('closes when the focus leaves it empty, leaving the focus where it went, and stays open with text', async () => {
    await renderStrip();
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    act(() => elsewhere.focus());
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(elsewhere);
    openStrip();
    type('Keep me');
    act(() => elsewhere.focus());
    expect(field().value).toBe('Keep me');
  });

  it('says the cap in its own line, sending nothing and keeping the text, with no banner', async () => {
    onServer = makeBoard(...Array.from({ length: BOARD_LIMITS.openCards }, (_, i) => makeCard(`c${i}`.padEnd(12, 'x'), `Card ${i}`, { position: i + 1 })));
    await renderStrip();
    enter('One more');
    await settle();
    expect(api.addItem).not.toHaveBeenCalled();
    expect(error()).toBe(BOARD.full);
    expect(field().getAttribute('aria-describedby')).toBe('later-strip-error');
    expect(field().value).toBe('One more');
    expect(warnQuietly).not.toHaveBeenCalled();
    expect(warnSaveFailed).not.toHaveBeenCalled();
  });

  // Under StrictMode too, whose second mount runs the effect's cleanup once: the strip must still know it is mounted.
  it.each([false, true])(
    'says a failed save in its own line with no banner, putting the title back only into an empty box (StrictMode: %s)',
    async (strict) => {
      vi.mocked(api.addItem).mockImplementationOnce(fail);
      await renderStrip({ strict });
      enter('First thought');
      await settle();
      expect(error()).toBe(SAVE_FAILED.body);
      expect(field().value).toBe('First thought');
      const answer = deferredAnswer<Board>();
      vi.mocked(api.addItem).mockReturnValueOnce(answer.promise);
      enter('Second thought');
      // The next Enter clears the line.
      expect(error()).toBeNull();
      expect(field().getAttribute('aria-describedby')).toBeNull();
      type('Typed since');
      answer.reject(new Error('offline'));
      await settle();
      expect(error()).toBe(SAVE_FAILED.body);
      expect(field().value).toBe('Typed since');
      expect(warnSaveFailed).not.toHaveBeenCalled();
    },
  );

  it('leaves a save that fails after its strip closed, or one from an earlier opening, to the banner', async () => {
    const first = deferredAnswer<Board>();
    vi.mocked(api.addItem).mockReturnValueOnce(first.promise);
    await renderStrip();
    enter('Gone');
    fireEvent.keyDown(field(), { key: 'Escape' });
    first.reject(new Error('offline'));
    await settle();
    expect(warnSaveFailed).toHaveBeenCalledOnce();

    const second = deferredAnswer<Board>();
    vi.mocked(api.addItem).mockReturnValueOnce(second.promise);
    openStrip();
    enter('Earlier');
    fireEvent.keyDown(field(), { key: 'Escape' });
    openStrip();
    second.reject(new Error('offline'));
    await settle();
    expect(warnSaveFailed).toHaveBeenCalledTimes(2);
    expect(error()).toBeNull();
    expect(field().value).toBe('');
  });

  it('keeps its text while hidden on the Board, and leaves a save that fails while hidden to the banner', async () => {
    const answer = deferredAnswer<Board>();
    vi.mocked(api.addItem).mockReturnValueOnce(answer.promise);
    const hide = await renderStrip();
    enter('Sent while shown');
    type('Half typed');
    hide(true);
    expect(document.getElementById('later-strip')!.hidden).toBe(true);
    answer.reject(new Error('offline'));
    await settle();
    expect(warnSaveFailed).toHaveBeenCalledOnce();
    expect(error()).toBeNull();
    hide(false);
    expect(document.getElementById('later-strip')!.hidden).toBe(false);
    expect(field().value).toBe('Half typed');
    expect(error()).toBeNull();
  });

  it("starts from the boxes' shared category, writes a pick to it, and reads it again when shown after the Board", async () => {
    localStorage.setItem(USER_KEYS.captureCategory, TICKETS.uid);
    const hide = await renderStrip();
    const chip = () => screen.getByRole('button', { name: /^Category for new cards: / });
    expect(chip().getAttribute('aria-label')).toBe('Category for new cards: Tickets');
    fireEvent.click(chip());
    fireEvent.click(screen.getByRole('option', { name: 'Admin' }));
    expect(localStorage.getItem(USER_KEYS.captureCategory)).toBe(ADMIN.uid);
    expect(chip().getAttribute('aria-label')).toBe('Category for new cards: Admin');
    hide(true);
    // Later's own box picks another on the Board.
    localStorage.setItem(USER_KEYS.captureCategory, TICKETS.uid);
    hide(false);
    expect(chip().getAttribute('aria-label')).toBe('Category for new cards: Tickets');
  });
});
