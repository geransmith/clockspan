// @vitest-environment happy-dom
import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { emptyRow } from '../lib/priorities';
import type { CategoryPick } from '../lib/board';
import { MINUTE_MS } from '../../../shared/dates.js';
import { ADMIN, completedSession, makePick, makePriority, makeSession, NEW_CATEGORY, QUEUE, settle, T0, TICKETS } from '../test/hooks';
import type { Priority } from '../types';
import { FILED_QUEUE, renderCard, renderOnStore, routineRow, textbox } from './Priorities.testkit';

vi.mock('../api');
vi.mock('../lib/alerts');

describe("Priorities: a row's category", () => {
  const chip = (n: number) => screen.queryByRole('button', { name: new RegExp(`^Category for priority ${n}:`) });
  const option = (name: string) => screen.getByRole('option', { name });
  /** The card with the chip's data, over Tickets and Admin unless given. */
  const withPick = (rows: Priority[], pick: CategoryPick = makePick([TICKETS, ADMIN])) => renderCard(rows, [], pick);

  it('puts a chip at the end of each row with text, and none on an empty row', async () => {
    await withPick([makePriority(1, 'Report', { categoryUid: TICKETS.uid }), makePriority(2, 'Email')]);
    expect(chip(1)!.getAttribute('aria-label')).toBe('Category for priority 1: Tickets');
    expect(chip(2)!.getAttribute('aria-label')).toBe('Category for priority 2: none');
    expect(chip(3)).toBeNull();
    const rows = [...document.querySelectorAll('.priority-row')];
    // Tick, text, note, chip, then ×.
    expect([...rows[0]!.querySelectorAll('input, textarea, button')].map((el) => el.getAttribute('aria-label'))).toEqual([
      'Priority 1 done',
      'Priority 1',
      'Add a note to priority 1',
      'Category for priority 1: Tickets',
      'Remove priority 1',
    ]);
  });

  it("gives every row the chip's column, an empty one with no chip included", async () => {
    const rows = [makePriority(1, 'A'), makePriority(2, 'B'), makePriority(3, 'C'), emptyRow(4)];
    await withPick(rows);
    const shown = [...document.querySelectorAll('.priority-row')];
    expect(shown.map((r) => r.classList.contains('priority-row--chip'))).toEqual([true, true, true, true]);
    // The empty row past the usual count: the column, its ×, and no chip.
    expect(chip(4)).toBeNull();
    expect(shown[3]!.querySelector('.priority-end')).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove priority 4' })).toBeTruthy();
  });

  it("shows no chip and no chip column before the board's first read, and a written row's end holds its note button alone", async () => {
    await renderCard([makePriority(1, 'Report', { categoryUid: TICKETS.uid }), emptyRow(2), emptyRow(3), emptyRow(4)]);
    expect(chip(1)).toBeNull();
    expect(document.querySelectorAll('.priority-row')).toHaveLength(4);
    expect(document.querySelector('.priority-row--chip')).toBeNull();
    const ends = [...document.querySelectorAll('.priority-end')];
    expect(ends.map((end) => [...end.children].map((el) => el.getAttribute('aria-label')))).toEqual([['Add a note to priority 1']]);
  });

  it('puts the chip before the × on a row past the usual count', async () => {
    const rows = [makePriority(1, 'A'), makePriority(2, 'B'), makePriority(3, 'C'), makePriority(4, 'D')];
    await withPick(rows);
    const row = document.querySelectorAll('.priority-row')[3]!;
    expect(row.className).toContain('priority-row--chip');
    expect([...row.querySelectorAll('textarea, button')].map((el) => el.getAttribute('aria-label'))).toEqual([
      'Priority 4',
      'Add a note to priority 4',
      'Category for priority 4: none',
      'Remove priority 4',
    ]);
  });

  it('saves a pick at once, with the text typed before it', async () => {
    const { onChange, saved } = await withPick([makePriority(1, 'Report')]);
    act(() => textbox(1).focus());
    fireEvent.change(textbox(1), { target: { value: 'Report for Acme' } });
    // The list takes the focus from the field as it opens, which saves the text, as any blur does.
    fireEvent.click(chip(1)!);
    fireEvent.click(option('Admin'));
    expect(saved()[0]).toMatchObject({ text: 'Report for Acme', categoryUid: ADMIN.uid });
    expect(chip(1)!.getAttribute('aria-label')).toBe('Category for priority 1: Admin');
    // Nothing waited on the debounce.
    const sent = onChange.mock.calls.length;
    await settle(400);
    expect(onChange).toHaveBeenCalledTimes(sent);
  });

  it('files a pick under the row whose chip made it, leaving the others as they were', async () => {
    const { saved } = await withPick([makePriority(1, 'Report', { categoryUid: TICKETS.uid }), makePriority(2, 'Email')]);
    fireEvent.click(chip(2)!);
    fireEvent.click(option('Admin'));
    expect(saved().map((p) => [p.text, p.categoryUid])).toEqual([
      ['Report', TICKETS.uid],
      ['Email', ADMIN.uid],
      ['', null],
    ]);
    expect(chip(2)!.getAttribute('aria-label')).toBe('Category for priority 2: Admin');
    expect(chip(1)!.getAttribute('aria-label')).toBe('Category for priority 1: Tickets');
  });

  it("closes a row's list when another device's change moves a different row to its place", async () => {
    const report = makePriority(1, 'Report');
    const email = makePriority(2, 'Email');
    const { again, onChange } = await withPick([report, email]);
    fireEvent.click(chip(2)!);
    expect(screen.getByRole('listbox')).toBeTruthy();
    // The phone removed the report: the email moves up, and an invoice row comes in second.
    again([{ ...email, position: 1 }, makePriority(2, 'Invoices', { uid: 'invoices0000' })]);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(chip(2)!.getAttribute('aria-label')).toBe('Category for priority 2: none');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('takes a category made in the chip on the row, and clears one with No category', async () => {
    const pick = makePick([TICKETS]);
    const { saved } = await withPick([makePriority(1, 'Report', { categoryUid: TICKETS.uid })], pick);
    fireEvent.click(chip(1)!);
    fireEvent.click(option('No category'));
    expect(saved()[0]!.categoryUid).toBeNull();
    fireEvent.click(chip(1)!);
    const box = screen.getByRole('textbox', { name: 'New category' });
    fireEvent.change(box, { target: { value: 'Follow-ups' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(pick.create).toHaveBeenCalledWith('Follow-ups');
    expect(saved()[0]!.categoryUid).toBe(NEW_CATEGORY);
  });

  it('sends a pick through the day store as a change from the rows it was made on, and the server keeps it', async () => {
    const report = makePriority(1, 'Report');
    const { stored, answer } = await renderOnStore([report], makePick([TICKETS]));
    fireEvent.click(chip(1)!);
    fireEvent.click(option('Tickets'));
    expect(api.putPriorities).toHaveBeenCalledTimes(1);
    const [, list, base] = vi.mocked(api.putPriorities).mock.lastCall!;
    expect(list[0]).toMatchObject({ uid: report.uid, categoryUid: TICKETS.uid });
    expect(base?.[0]).toMatchObject({ uid: report.uid, categoryUid: null });
    await answer();
    expect(stored()[0]).toMatchObject({ uid: report.uid, categoryUid: TICKETS.uid });
    expect(chip(1)!.getAttribute('aria-label')).toBe('Category for priority 1: Tickets');
  });

  it('hides the chip while the box is blank, and shows the category again with the name', async () => {
    await withPick([makePriority(1, 'Report', { categoryUid: TICKETS.uid })]);
    act(() => textbox(1).focus());
    fireEvent.change(textbox(1), { target: { value: '' } });
    expect(chip(1)).toBeNull();
    fireEvent.blur(textbox(1));
    expect(chip(1)!.getAttribute('aria-label')).toBe('Category for priority 1: Tickets');
  });
});

describe('Priorities: the time logged on a row', () => {
  const REPORT = makePriority(1, 'Report');
  /** Two finished sessions on `uid`, 100 minutes in all. */
  const finished = (uid: string | null) => [
    completedSession(1, T0, 60 * 60, { priorityUid: uid }),
    completedSession(2, T0 + 2 * 60 * MINUTE_MS, 40 * 60, { priorityUid: uid }),
  ];
  const logged = () => document.querySelector('.priority-logged');

  it("shows the day's finished time first in the row's end, named for today", async () => {
    await renderCard([REPORT, makePriority(2, 'Email')], finished(REPORT.uid), makePick());
    const label = screen.getByRole('img', { name: '1 hour 40 minutes logged today' });
    expect(label.textContent).toBe('1h 40m');
    expect(document.querySelector('.priority-end')!.firstElementChild).toBe(label);
    expect(document.querySelectorAll('.priority-logged')).toHaveLength(1);
  });

  it("puts it before a routine's repeat mark", async () => {
    await renderCard([routineRow(1, FILED_QUEUE)], finished(QUEUE.uid), makePick([TICKETS]));
    const end = document.querySelector('.priority-end')!;
    expect([...end.children].map((el) => el.getAttribute('aria-label'))).toEqual([
      '1 hour 40 minutes logged today',
      'Repeats',
      'Add a note to priority 1',
      null,
    ]);
  });

  it('names it on this day on any other date', async () => {
    await renderCard([REPORT], finished(REPORT.uid), makePick(), null, false);
    expect(screen.getByRole('img', { name: '1 hour 40 minutes logged on this day' }).textContent).toBe('1h 40m');
  });

  it('shows nothing for a running timer, under a minute, or for time on other days', async () => {
    const { unmount } = await renderCard([REPORT], [makeSession({ startedAt: T0 - 30 * MINUTE_MS, priorityUid: REPORT.uid })], makePick());
    expect(logged()).toBeNull();
    unmount();
    const short = await renderCard([REPORT], [completedSession(1, T0, 45, { priorityUid: REPORT.uid })], makePick());
    expect(logged()).toBeNull();
    short.unmount();
    await renderCard([makePriority(1, 'Report', { listed: 2, logged: 80 * 60 })], [], makePick());
    expect(logged()).toBeNull();
  });

  it("shows nothing before the board's first read, nor on a row with no task beside time on no task", async () => {
    const { unmount } = await renderCard([REPORT], finished(REPORT.uid), null);
    expect(logged()).toBeNull();
    unmount();
    await renderCard([makePriority(1, 'Report', { uid: null })], finished(null), makePick());
    expect(screen.getByRole('button', { name: /^Category for priority 1:/ })).toBeTruthy();
    expect(logged()).toBeNull();
  });
});
