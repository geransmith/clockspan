// @vitest-environment happy-dom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import * as api from '../../api';
import { warnSaveFailed } from '../../lib/alerts';
import { withItemPatch } from '../../lib/board';
import { deferredAnswer, makeDay, serveRange, settle } from '../../test/hooks';
import type { Board as BoardData, Priority } from '../../types';
import { changedElsewhere, closeCard, column, dialog, MON, openCard, renderBoard, row, serveBoard, TUE, WED } from './Board.testkit';

vi.mock('../../api');
vi.mock('../../lib/alerts');

let onServer: BoardData;
let lists: Record<string, Priority[]>;
serveBoard({ board: () => onServer, setBoard: (board) => (onServer = board), lists: () => lists, setLists: (fresh) => (lists = fresh) });

describe("a card's note", () => {
  const box = (title: string) => screen.queryByRole('textbox', { name: `Note for ${title}` }) as HTMLTextAreaElement | null;
  const withNote = () => ({ ...onServer, cards: onServer.cards.map((c) => (c.uid === 'later0000001' ? { ...c, note: 'From ticket 4821.' } : c)) });

  it("marks a card with a note on its meta line, and no other, and gives its button the note's start as a title, with no note button on any card", async () => {
    onServer = withNote();
    await renderBoard();
    const marks = screen.getAllByRole('img', { name: 'Has a note' });
    expect(marks).toHaveLength(1);
    expect(marks[0]!.closest('.board-card-meta')?.closest('.board-card')?.querySelector('.board-card-title')?.textContent).toBe('Write a KB');
    expect([...document.querySelectorAll('.board-card-open[title]')].map((b) => [b.textContent, b.getAttribute('title')])).toEqual([
      ['Write a KB', 'From ticket 4821.'],
    ]);
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
    fireEvent.click(screen.getByRole('button', { name: 'Earlier This Week · 3' }));
    openCard('Tuesday row');
    expect(box('Tuesday row')).toBeNull();
    expect(dialog().querySelector('.note-text')?.textContent).toBe('Acme first');
    closeCard();
    openCard('Monday row');
    expect(dialog().querySelector('.note-field')).toBeNull();
  });
});
