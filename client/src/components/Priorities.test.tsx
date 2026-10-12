// @vitest-environment happy-dom
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MINUTE_MS } from '../../../shared/dates.js';
import { MAX_PRIORITIES } from '../../../shared/settings.js';
import * as api from '../api';
import { playSound, unlockAudio, warnSaveFailed } from '../lib/alerts';
import { BLANK_HINT, PRIORITY_WARNINGS, REMOVE_TASK, RENAME_HINT, WARNING_ACTIONS } from '../lib/copy';
import { emptyRow } from '../lib/priorities';
import { answered, completedSession, makeBoard, makePriority, makeSession, makeSettings, pressKey, rowUid, settle, T0 } from '../test/hooks';
import type { Priority, Session } from '../types';
import { FILED_QUEUE, renderCard, renderOnStore, routineRow, textbox } from './Priorities.testkit';

vi.mock('../api');
vi.mock('../lib/alerts');

const tick = (n: number) => screen.getByLabelText(`Priority ${n} done`) as HTMLInputElement;

describe('Priorities', () => {
  it('starts with the configured rows and saves text 400 ms after the last keystroke', async () => {
    const { onChange, saved } = await renderCard();
    expect(screen.getAllByRole('textbox')).toHaveLength(3);
    expect([1, 2, 3].map((n) => textbox(n).placeholder)).toEqual(['The one thing to get done', 'Another priority', 'Another priority']);
    fireEvent.change(textbox(1), { target: { value: 'Write' } });
    fireEvent.change(textbox(1), { target: { value: 'Write the report' } });
    await settle(399);
    expect(onChange).not.toHaveBeenCalled();
    await settle(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    // The row gets its id and its time the first time it has text.
    expect(saved()[0]).toMatchObject({ position: 1, text: 'Write the report', done: false, addedAt: T0 });
    expect(saved()[0]!.uid).toMatch(/^[0-9a-f]{32}$/);
  });

  it('saves at once when the row is left, and keeps a pasted line break out', async () => {
    const { onChange, saved } = await renderCard();
    fireEvent.change(textbox(2), { target: { value: 'Call\nthe bank' } });
    fireEvent.blur(textbox(2));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(saved()[1]!.text).toBe('Call the bank');
    await settle(400);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('still saves text typed just before the card goes away (another day opened)', async () => {
    const { unmount, onChange, saved } = await renderCard();
    fireEvent.change(textbox(1), { target: { value: 'Typed, then left' } });
    unmount();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(saved()[0]!.text).toBe('Typed, then left');
    await settle(400);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('only ticks a row with text, and saves the tick straight away', async () => {
    const { onChange, saved } = await renderCard([makePriority(1, 'Report')]);
    expect(tick(2).disabled).toBe(true);
    fireEvent.click(tick(1));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(saved()[0]).toMatchObject({ text: 'Report', done: true });
  });

  it('sends each list with the rows it was made on, and the stored rows once it takes them up', async () => {
    const report = makePriority(1, 'Report');
    const { onChange, saved, again } = await renderCard([report]);
    fireEvent.click(tick(1));
    expect(onChange).toHaveBeenCalledExactlyOnceWith([{ ...report, done: true }, emptyRow(2), emptyRow(3)], [report, emptyRow(2), emptyRow(3)]);
    // The store's copy now shows the save, with a row from another device: the card takes it up.
    await settle();
    const stored = [...saved(), makePriority(4, 'From the phone', { uid: 'phone0000000' })];
    again(stored);
    fireEvent.change(textbox(2), { target: { value: 'Email' } });
    fireEvent.blur(textbox(2));
    expect(onChange.mock.lastCall![1]).toEqual(stored);
  });

  it('celebrates a tick from its box with the priority sound, and not an untick', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(answered(makeSettings({ sounds: { ...makeSettings().sounds, priorityDone: 'pop' } })));
    await renderCard([makePriority(1, 'Report'), makePriority(2, 'Invoices', { done: true })]);
    fireEvent.click(tick(1));
    // The sound plays after the render, so the tap unlocks audio for iOS first.
    expect(unlockAudio).toHaveBeenCalled();
    expect(playSound).toHaveBeenCalledExactlyOnceWith('pop');
    expect(document.querySelector('.burst')).not.toBeNull();
    fireEvent.click(tick(2));
    expect(playSound).toHaveBeenCalledTimes(1);
  });

  it('sends Add Priority to the first empty row, with no warning and nothing saved', async () => {
    const { onChange } = await renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Add Priority' }));
    expect(screen.getByRole('status').textContent).toBe('');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getAllByRole('textbox')).toHaveLength(3);
    expect(document.activeElement).toBe(textbox(1));
  });

  it('adds on N as Add Priority does, typing no n, with the focus on Add Priority when it asks first', async () => {
    const add = () => screen.getByRole('button', { name: 'Add Priority' });
    await renderCard([makePriority(1, 'Report')]);
    expect(add().getAttribute('aria-keyshortcuts')).toBe('N');
    expect(pressKey('n')).toBe(false);
    expect(document.activeElement).toBe(textbox(2));
    // In the box an N is typing.
    expect(pressKey('n')).toBe(true);
    cleanup();

    const { onChange } = await renderCard([makePriority(1, 'Report'), makePriority(2, 'Invoices'), makePriority(3, 'Email')]);
    pressKey('N', { shiftKey: true });
    expect(document.activeElement).toBe(add());
    expect(PRIORITY_WARNINGS.fresh.some((w) => screen.getByRole('status').textContent!.includes(w))).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    cleanup();

    // A full list has no Add Priority, and N does nothing.
    await renderCard(Array.from({ length: MAX_PRIORITIES }, (_, i) => makePriority(i + 1, `Row ${i + 1}`)));
    expect(pressKey('n')).toBe(true);
  });

  it('finds an empty row between written ones', async () => {
    await renderCard([makePriority(1, 'A'), makePriority(3, 'C')]);
    fireEvent.click(screen.getByRole('button', { name: 'Add Priority' }));
    expect(document.activeElement).toBe(textbox(2));
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('asks before a row past the usual count, then adds it; the extra row can be removed', async () => {
    const { onChange, saved } = await renderCard([makePriority(1, 'Report'), makePriority(2, 'Invoices'), makePriority(3, 'Email')]);
    expect(screen.getByRole('status').textContent).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Add Priority' }));
    expect(onChange).not.toHaveBeenCalled();
    // The live region is there before the warning, so a screen reader hears it arrive.
    const status = screen.getByRole('status');
    expect(PRIORITY_WARNINGS.fresh.some((w) => status.textContent!.includes(w))).toBe(true);
    // A fresh nudge has no count, so the foot keeps its own.
    expect(screen.getByText('0 of 3 done')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: WARNING_ACTIONS.fresh.keep }));
    expect(screen.getByRole('status')).toBe(status);
    expect(status.textContent).toBe('');
    // The notice took its buttons with it, so focus goes to Add Priority rather than the page.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add Priority' }));

    fireEvent.click(screen.getByRole('button', { name: 'Add Priority' }));
    fireEvent.click(screen.getByRole('button', { name: WARNING_ACTIONS.fresh.add }));
    expect(saved()).toHaveLength(4);
    expect(screen.getAllByRole('textbox')).toHaveLength(4);
    expect(document.activeElement).toBe(textbox(4));

    fireEvent.click(screen.getByRole('button', { name: 'Remove priority 4' }));
    expect(saved()).toHaveLength(3);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add Priority' }));
  });

  it('keeps a row it added while free, though the stored list comes back without it, until the server holds a task there', async () => {
    const written = [makePriority(1, 'Report'), makePriority(2, 'Invoices'), makePriority(3, 'Email')];
    const { again, saved } = await renderCard(written);
    fireEvent.click(screen.getByRole('button', { name: 'Add Priority' }));
    fireEvent.click(screen.getByRole('button', { name: WARNING_ACTIONS.fresh.add }));
    await settle();
    // The server keeps no free row.
    again([...written]);
    expect(screen.getAllByRole('textbox')).toHaveLength(4);
    expect(document.activeElement).toBe(textbox(4));
    fireEvent.change(textbox(4), { target: { value: 'Call the bank' } });
    fireEvent.blur(textbox(4));
    await settle();
    const bank = saved()[3]!;
    expect(bank).toMatchObject({ position: 4, text: 'Call the bank' });
    again([...written, bank]);
    // Then another device takes it off.
    again([...written]);
    expect(screen.getAllByRole('textbox')).toHaveLength(3);
  });

  it('keeps focus on a remove button when a row before the last is removed', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(answered(makeSettings({ priorityCount: 1 })));
    const { saved } = await renderCard([makePriority(1, 'A'), makePriority(2, 'B'), makePriority(3, 'C')]);
    const remove2 = screen.getByRole('button', { name: 'Remove priority 2' });
    remove2.focus();
    fireEvent.click(remove2);
    expect(saved().map((p) => p.text)).toEqual(['A', 'C']);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove priority 2' }));
  });

  it('with every row ticked, warns from the "complete" set and lists what is done', async () => {
    await renderCard([makePriority(1, 'Report', { done: true }), makePriority(2, 'Invoices', { done: true }), makePriority(3, 'Email', { done: true })]);
    fireEvent.click(screen.getByRole('button', { name: 'Add Priority' }));
    const status = screen.getByRole('status');
    expect(PRIORITY_WARNINGS.complete.some((w) => status.textContent!.includes(w))).toBe(true);
    expect(status.textContent).toContain('3 of 3 done');
    expect(screen.getByRole('button', { name: WARNING_ACTIONS.complete.add })).toBeTruthy();
    // The nudge heads with the count, so the foot leaves it out until the nudge goes.
    expect(screen.getAllByText('3 of 3 done')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: WARNING_ACTIONS.complete.keep }));
    expect(screen.getByText('3 of 3 done')).toBeTruthy();
  });
});

describe('Priorities: a blank name', () => {
  const rows = () => [makePriority(1, 'Report'), makePriority(2, 'Email')];
  const hint = (name: string) => screen.queryByText(BLANK_HINT(name));
  const blankOut = (n: number) => {
    act(() => textbox(n).focus());
    fireEvent.change(textbox(n), { target: { value: '' } });
  };

  it("saves the name as it was, says so as the field's description, and brings the name back when the box is left", async () => {
    const { onChange } = await renderCard(rows());
    blankOut(1);
    expect(textbox(1).getAttribute('aria-describedby')).toBe(hint('Report')!.id);
    await settle(400);
    expect(textbox(1).value).toBe('');
    fireEvent.blur(textbox(1));
    expect(textbox(1).value).toBe('Report');
    expect(hint('Report')).toBeNull();
    expect(textbox(1).hasAttribute('aria-describedby')).toBe(false);
    expect(onChange).toHaveBeenCalled();
    for (const [list] of onChange.mock.calls) expect(list.map((p) => p.text)).toEqual(['Report', 'Email', '']);
  });

  it('brings the name back on Escape, with the focus kept in the box', async () => {
    await renderCard(rows());
    blankOut(2);
    fireEvent.keyDown(textbox(2), { key: 'Escape' });
    expect(textbox(2).value).toBe('Email');
    expect(document.activeElement).toBe(textbox(2));
    // Escape on a box with text leaves it be.
    fireEvent.change(textbox(2), { target: { value: 'Email Bob' } });
    fireEvent.keyDown(textbox(2), { key: 'Escape' });
    expect(textbox(2).value).toBe('Email Bob');
  });

  it("keeps the row's tick, with its box disabled, counted as a done row of the list, and saves no change to it", async () => {
    const { onChange } = await renderCard(rows());
    fireEvent.click(tick(1));
    blankOut(1);
    expect(tick(1).checked).toBe(true);
    expect(tick(1).disabled).toBe(true);
    expect(screen.getByText('1 of 2 done')).toBeTruthy();
    await settle(400);
    fireEvent.blur(textbox(1));
    expect(tick(1).checked).toBe(true);
    for (const [list] of onChange.mock.calls) expect([list[0]!.text, list[0]!.done]).toEqual(['Report', true]);
  });

  it("saves the other rows' changes with the name as it was, before and as the card goes away", async () => {
    const { onChange, unmount, saved } = await renderCard(rows());
    blankOut(1);
    fireEvent.click(tick(2));
    expect(saved().map((p) => [p.text, p.done])).toEqual([
      ['Report', false],
      ['Email', true],
      ['', false],
    ]);
    fireEvent.change(textbox(2), { target: { value: 'Email Bob' } });
    const sent = onChange.mock.calls.length;
    unmount();
    expect(onChange).toHaveBeenCalledTimes(sent + 1);
    expect(saved().map((p) => p.text)).toEqual(['Report', 'Email Bob', '']);
  });

  it('keeps the box empty while it has the focus, though the stored list changes under it', async () => {
    const { again } = await renderCard(rows());
    blankOut(1);
    fireEvent.click(tick(2));
    again([makePriority(1, 'Report'), makePriority(2, 'Email', { done: true })]);
    expect(textbox(1).value).toBe('');
    fireEvent.blur(textbox(1));
    expect(textbox(1).value).toBe('Report');
  });

  it('says so for a task typed in a free row, saved and then emptied in one stay in the box', async () => {
    const { saved, again } = await renderCard();
    act(() => textbox(1).focus());
    fireEvent.change(textbox(1), { target: { value: 'Call the bank' } });
    await settle(400);
    // The save's answer, with the task the first key made.
    again(saved());
    fireEvent.change(textbox(1), { target: { value: '' } });
    expect(textbox(1).getAttribute('aria-describedby')).toBe(hint('Call the bank')!.id);
  });

  it('makes a row typed and emptied before it was saved a free row again, with no hint and nothing sent', async () => {
    const { onChange } = await renderCard();
    act(() => textbox(1).focus());
    fireEvent.change(textbox(1), { target: { value: 'Call' } });
    fireEvent.change(textbox(1), { target: { value: '' } });
    expect(document.querySelector('.priority-hint')).toBeNull();
    fireEvent.blur(textbox(1));
    expect(onChange).toHaveBeenLastCalledWith([emptyRow(1), emptyRow(2), emptyRow(3)], [emptyRow(1), emptyRow(2), emptyRow(3)]);
    expect(screen.queryByRole('button', { name: 'Remove priority 1' })).toBeNull();
  });
});

describe('Priorities: the rename hint', () => {
  const hint = (n: number) => screen.queryByText(RENAME_HINT(n));

  it("shows while a name that earlier days' lists hold is retyped in the focused box, as its description", async () => {
    await renderCard([makePriority(1, 'Report', { earlier: 3 }), makePriority(2, 'Email')]);
    act(() => textbox(1).focus());
    expect(hint(3)).toBeNull();
    fireEvent.change(textbox(1), { target: { value: 'Report for Acme' } });
    expect(textbox(1).getAttribute('aria-describedby')).toBe(hint(3)!.id);
    // Typed back to the name it had: nothing renamed.
    fireEvent.change(textbox(1), { target: { value: 'Report' } });
    expect(hint(3)).toBeNull();
    fireEvent.change(textbox(1), { target: { value: 'Report for Acme' } });
    fireEvent.blur(textbox(1));
    expect(hint(3)).toBeNull();
  });

  it('says nothing for a task no earlier day holds', async () => {
    await renderCard([makePriority(1, 'Report', { listed: 2 })]);
    act(() => textbox(1).focus());
    fireEvent.change(textbox(1), { target: { value: 'Report for Acme' } });
    expect(document.querySelector('.priority-hint')).toBeNull();
  });
});

describe('Priorities: ×', () => {
  const x = (n: number) => screen.getByRole('button', { name: `Remove priority ${n}` });
  const dialog = () => screen.queryByRole('dialog');
  const offDay = () => fireEvent.click(screen.getByRole('button', { name: REMOVE_TASK.offDay }));
  const everywhere = () => fireEvent.click(screen.getByRole('button', { name: REMOVE_TASK.everywhere }));

  it('is on every row with a task, and on every row past Rows per day', async () => {
    await renderCard([makePriority(1, 'Report'), emptyRow(2), emptyRow(3), emptyRow(4)]);
    expect(screen.getAllByRole('button', { name: /^Remove priority/ }).map((b) => b.getAttribute('aria-label'))).toEqual([
      'Remove priority 1',
      'Remove priority 4',
    ]);
  });

  it('takes a task on no other day and with no time logged off at once, leaving a free row with the focus in it', async () => {
    const { saved, onDeleteTask } = await renderCard([makePriority(1, 'Report'), makePriority(2, 'Email'), makePriority(3, 'Invoices')]);
    fireEvent.click(x(2));
    expect(dialog()).toBeNull();
    expect(saved().map((p) => [p.text, p.uid])).toEqual([
      ['Report', rowUid(1)],
      ['', null],
      ['Invoices', rowUid(3)],
    ]);
    expect(document.activeElement).toBe(textbox(2));
    expect(onDeleteTask).not.toHaveBeenCalled();
  });

  it('counts a note of spaces and line breaks alone as none: its button is empty and × asks nothing', async () => {
    const { saved } = await renderCard([makePriority(1, 'Report', { note: ' \n\n' })]);
    expect(screen.getByRole('button', { name: 'Add a note to priority 1' }).classList.contains('note-toggle--empty')).toBe(true);
    fireEvent.click(x(1));
    expect(dialog()).toBeNull();
    expect(saved()[0]).toEqual(emptyRow(1));
  });

  it("never asks on a recurring priority's row", async () => {
    const { saved } = await renderCard([routineRow(1, FILED_QUEUE, { listed: 5, logged: 3000, note: 'Tier 2 too.' })]);
    fireEvent.click(x(1));
    expect(dialog()).toBeNull();
    expect(saved()[0]).toEqual(emptyRow(1));
  });

  it("asks about a task on other days, with time logged on it, the day's own sessions added to the other days', a timer running on it included, or with a note", async () => {
    const email = makePriority(1, 'Email');
    const cases: [Priority, Session[], string][] = [
      [makePriority(1, 'Email', { listed: 3 }), [], REMOVE_TASK.body(2, null, false)],
      [makePriority(1, 'Email', { logged: 80 * 60 }), [], REMOVE_TASK.body(0, '1h 20m', false)],
      [email, [completedSession(1, T0, 30, { priorityUid: email.uid })], REMOVE_TASK.body(0, '1m', false)],
      [email, [makeSession({ startedAt: T0 - 12 * MINUTE_MS, priorityUid: email.uid })], REMOVE_TASK.body(0, '12m', false)],
      [
        makePriority(1, 'Email', { logged: 60 * 60 }),
        [makeSession({ startedAt: T0 - 12 * MINUTE_MS, priorityUid: email.uid })],
        REMOVE_TASK.body(0, '1h 12m', false),
      ],
      // On no other day, with no time logged: the note alone asks, since it goes with the task.
      [makePriority(1, 'Email', { note: 'Ask Kim' }), [], REMOVE_TASK.body(0, null, true)],
      [makePriority(1, 'Email', { listed: 2, note: 'Ask Kim' }), [], REMOVE_TASK.body(1, null, true)],
    ];
    for (const [row, sessions, body] of cases) {
      const { onChange, unmount } = await renderCard([row], sessions);
      fireEvent.click(x(1));
      expect(dialog()!.textContent).toContain(REMOVE_TASK.title('Email'));
      // The facts are read with the title.
      expect(document.getElementById(dialog()!.getAttribute('aria-describedby')!)!.textContent).toBe(body);
      expect(onChange).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("counts a running timer to the sheet's minute, as the board's Delete does, not the second of the press", async () => {
    const email = makePriority(1, 'Email');
    await renderCard([email], [makeSession({ startedAt: T0 - 12 * MINUTE_MS, priorityUid: email.uid })]);
    vi.setSystemTime(T0 + 50_000);
    fireEvent.click(x(1));
    expect(document.getElementById(dialog()!.getAttribute('aria-describedby')!)!.textContent).toBe(REMOVE_TASK.body(0, '12m', false));
  });

  it('changes nothing on Cancel, and gives the focus back to the ×', async () => {
    const { onChange, onDeleteTask } = await renderCard([makePriority(1, 'Email', { listed: 2 })]);
    act(() => x(1).focus());
    fireEvent.click(x(1));
    fireEvent.click(screen.getByRole('button', { name: REMOVE_TASK.cancel }));
    expect(dialog()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(onDeleteTask).not.toHaveBeenCalled();
  });

  it('takes the task off this day only with Off this day', async () => {
    const { saved, onDeleteTask } = await renderCard([makePriority(1, 'Report'), makePriority(2, 'Email', { listed: 2 })]);
    fireEvent.click(x(2));
    offDay();
    expect(dialog()).toBeNull();
    expect(saved()[1]).toEqual(emptyRow(2));
    expect(document.activeElement).toBe(textbox(2));
    expect(onDeleteTask).not.toHaveBeenCalled();
  });

  it('removes a row past Rows per day with Off this day', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(answered(makeSettings({ priorityCount: 1 })));
    const { saved } = await renderCard([makePriority(1, 'Report'), makePriority(2, 'Email', { listed: 2 })]);
    fireEvent.click(x(2));
    offDay();
    expect(saved().map((p) => p.text)).toEqual(['Report']);
  });

  it('takes the task off this day, then deletes it everywhere, with Delete everywhere', async () => {
    const { onChange, saved, onDeleteTask } = await renderCard([makePriority(1, 'Email', { logged: 600 })]);
    onDeleteTask.mockImplementation(() => {
      expect(onChange).toHaveBeenCalledTimes(1);
      return Promise.resolve();
    });
    fireEvent.click(x(1));
    everywhere();
    expect(saved()[0]).toEqual(emptyRow(1));
    expect(onDeleteTask).toHaveBeenCalledExactlyOnceWith(rowUid(1));
    await settle();
    expect(warnSaveFailed).not.toHaveBeenCalled();
  });

  it('raises the banner when the delete fails, and leaves the task off this day', async () => {
    const { saved, onDeleteTask } = await renderCard([makePriority(1, 'Email', { listed: 2 })]);
    onDeleteTask.mockRejectedValue(new Error('Request failed (500)'));
    fireEvent.click(x(1));
    everywhere();
    await settle();
    expect(warnSaveFailed).toHaveBeenCalledOnce();
    expect(saved()[0]).toEqual(emptyRow(1));
  });

  it('still deletes everywhere when another device took the task off this list while it asked', async () => {
    const email = makePriority(1, 'Email', { listed: 2 });
    const { again, onChange, onDeleteTask } = await renderCard([email]);
    fireEvent.click(x(1));
    again([]);
    everywhere();
    expect(dialog()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(onDeleteTask).toHaveBeenCalledExactlyOnceWith(email.uid);
  });
});

describe('Priorities on the day store', () => {
  it('keeps a row Add Priority put past Rows per day, with the focus in it, once the server answers without it, and saves it once typed in', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(answered(makeSettings({ priorityCount: 1 })));
    const { stored, answer } = await renderOnStore([makePriority(1, 'Report')]);
    fireEvent.click(screen.getByRole('button', { name: 'Add Priority' }));
    expect(document.activeElement).toBe(textbox(2));
    await answer();
    expect(screen.getAllByRole('textbox')).toHaveLength(2);
    expect(document.activeElement).toBe(textbox(2));
    fireEvent.change(textbox(2), { target: { value: 'Call the bank' } });
    fireEvent.blur(textbox(2));
    await settle();
    expect(stored().map((p) => p.text)).toEqual(['Report', 'Call the bank']);
  });

  it('keeps the row Add Anyway put past Rows per day the same, and lets its × take it away', async () => {
    const { stored, answer } = await renderOnStore([makePriority(1, 'Report'), makePriority(2, 'Invoices'), makePriority(3, 'Email')]);
    fireEvent.click(screen.getByRole('button', { name: 'Add Priority' }));
    fireEvent.click(screen.getByRole('button', { name: WARNING_ACTIONS.fresh.add }));
    await answer();
    expect(screen.getAllByRole('textbox')).toHaveLength(4);
    expect(document.activeElement).toBe(textbox(4));
    fireEvent.change(textbox(4), { target: { value: 'Call the bank' } });
    fireEvent.blur(textbox(4));
    await settle();
    expect(stored().map((p) => p.text)).toEqual(['Report', 'Invoices', 'Email', 'Call the bank']);

    fireEvent.click(screen.getByRole('button', { name: 'Add Priority' }));
    fireEvent.click(screen.getByRole('button', { name: WARNING_ACTIONS.fresh.add }));
    await settle();
    expect(screen.getAllByRole('textbox')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Remove priority 5' }));
    await settle();
    expect(screen.getAllByRole('textbox')).toHaveLength(4);
  });

  it('sends an untick made before the tick is answered as a change from the tick', async () => {
    const { stored, answer } = await renderOnStore([makePriority(1, 'Report')]);
    fireEvent.click(tick(1));
    await settle();
    fireEvent.click(tick(1));
    await answer();
    const sent = vi.mocked(api.putPriorities).mock.calls.map(([, list, base]) => [list[0]!.done, base![0]!.done]);
    expect(sent).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(stored()[0]!.done).toBe(false);
    expect(tick(1).checked).toBe(false);
  });

  it('keeps a row removed when its text was saved on the way out of it and not answered yet', async () => {
    const rows = [makePriority(1, 'Report'), makePriority(2, 'Invoices'), makePriority(3, 'Email'), emptyRow(4)];
    const { stored, answer } = await renderOnStore(rows);
    fireEvent.change(textbox(4), { target: { value: 'Call the bank' } });
    fireEvent.blur(textbox(4));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Remove priority 4' }));
    await answer();
    expect(stored().map((p) => p.text)).toEqual(['Report', 'Invoices', 'Email']);
    expect(screen.queryByLabelText('Priority 4')).toBeNull();
  });

  it('sends the list without the row, then deletes the task everywhere, with Delete everywhere', async () => {
    vi.mocked(api.deleteItem).mockResolvedValue(answered(makeBoard()));
    const { stored, answer } = await renderOnStore([makePriority(1, 'Report'), makePriority(2, 'Email', { listed: 3 })]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove priority 2' }));
    fireEvent.click(screen.getByRole('button', { name: REMOVE_TASK.everywhere }));
    await settle();
    // The delete waits for today's save without the row.
    expect(api.deleteItem).not.toHaveBeenCalled();
    await answer();
    expect(stored().map((p) => p.text)).toEqual(['Report']);
    expect(api.deleteItem).toHaveBeenCalledExactlyOnceWith(rowUid(2));
    expect(vi.mocked(api.putPriorities).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.deleteItem).mock.invocationCallOrder[0]!);
  });
});

describe("Priorities: a row's note", () => {
  const button = (n: number) => screen.getByRole('button', { name: new RegExp(`(^Note for|^Add a note to) priority ${n}$`) });
  const box = (n: number) => screen.queryByRole('textbox', { name: `Note for priority ${n}` }) as HTMLTextAreaElement | null;
  const open = (n: number) => fireEvent.click(button(n));
  const rows = () => [makePriority(1, 'Report', { note: 'Kim has the numbers.\nDue Friday.' }), makePriority(2, 'Email')];

  it("marks the button of a row with a note, its title the note's start, and offers one on each written row, closed until it is pressed", async () => {
    await renderCard([...rows(), emptyRow(3)]);
    expect([button(1).getAttribute('aria-label'), button(1).classList.contains('note-toggle--empty')]).toEqual(['Note for priority 1', false]);
    expect([button(2).getAttribute('aria-label'), button(2).classList.contains('note-toggle--empty')]).toEqual(['Add a note to priority 2', true]);
    expect([button(1).getAttribute('title'), button(2).getAttribute('title')]).toEqual(['Kim has the numbers.\nDue Friday.', 'Add a note']);
    expect(screen.queryByRole('button', { name: /priority 3$/ })).toBeNull();
    expect(button(1).getAttribute('aria-expanded')).toBe('false');
    expect(box(1)).toBeNull();
  });

  it('opens the box with the focus in it, with no title on its button, and Escape closes it with the text kept and the focus back on its button', async () => {
    await renderCard(rows());
    open(1);
    expect(button(1).getAttribute('aria-expanded')).toBe('true');
    expect(button(1).hasAttribute('title')).toBe(false);
    expect(button(1).getAttribute('aria-controls')).toBe(box(1)!.id);
    expect(document.activeElement).toBe(box(1));
    expect(box(1)!.value).toBe('Kim has the numbers.\nDue Friday.');
    fireEvent.change(box(1)!, { target: { value: 'Kim has the numbers.' } });
    fireEvent.keyDown(box(1)!, { key: 'Escape' });
    expect(box(1)).toBeNull();
    expect(document.activeElement).toBe(button(1));
    open(1);
    expect(box(1)!.value).toBe('Kim has the numbers.');
  });

  it('saves a note 400 ms after the last key as the server stores it, and at once when the box is left, apart from the list', async () => {
    const { onChange, onNote } = await renderCard(rows());
    open(2);
    fireEvent.change(box(2)!, { target: { value: 'Ask\u0007 Sam\n' } });
    await settle(399);
    expect(onNote).not.toHaveBeenCalled();
    await settle(1);
    expect(onNote.mock.calls).toEqual([[rowUid(2), 'Ask Sam\n']]);
    fireEvent.change(box(2)!, { target: { value: 'Ask Sam first' } });
    fireEvent.blur(box(2)!);
    await settle();
    expect(onNote.mock.lastCall).toEqual([rowUid(2), 'Ask Sam first']);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps a note whose save failed in its box, closed or not, and sends it again on the next edit or when the box is left', async () => {
    const { onNote } = await renderCard(rows());
    onNote.mockResolvedValue(false);
    open(2);
    fireEvent.change(box(2)!, { target: { value: 'Ask Sam' } });
    fireEvent.keyDown(box(2)!, { key: 'Escape' });
    await settle();
    expect(onNote).toHaveBeenCalledTimes(1);
    open(2);
    expect(box(2)!.value).toBe('Ask Sam');
    fireEvent.blur(box(2)!);
    await settle();
    expect(onNote).toHaveBeenCalledTimes(2);
    onNote.mockResolvedValue(true);
    fireEvent.change(box(2)!, { target: { value: 'Ask Sam today' } });
    await settle(400);
    expect(onNote.mock.lastCall).toEqual([rowUid(2), 'Ask Sam today']);
  });

  it('takes up a note saved elsewhere while nothing is being typed, and hides the box while the name is blank', async () => {
    const { again } = await renderCard(rows());
    open(1);
    again([makePriority(1, 'Report', { note: 'From Kim' }), makePriority(2, 'Email')]);
    expect(box(1)!.value).toBe('From Kim');
    act(() => textbox(1).focus());
    fireEvent.change(textbox(1), { target: { value: '' } });
    expect(box(1)).toBeNull();
  });
});
