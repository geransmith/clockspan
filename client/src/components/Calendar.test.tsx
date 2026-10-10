// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MINUTE_MS } from '../../../shared/dates.js';
import * as api from '../api';
import { CHECK_PUNCHES, LOAD_FAILED } from '../lib/copy';
import { formatMonth } from '../lib/format';
import { answered, makeDay, makeSettings, punchesAt, serveRange, SettingsAndDays, settle } from '../test/hooks';
import { Calendar } from './Calendar';

vi.mock('../api');

// The last day of a month, and the first of the next.
const LAST = '2026-09-30';
const FIRST = '2026-10-01';
const LAST_EVENING = new Date(2026, 8, 30, 17).getTime();
const AFTER_MIDNIGHT = new Date(2026, 9, 1, 0, 1).getTime();
const clockedIn = makeDay(LAST, { punches: punchesAt(new Date(2026, 8, 30, 9).getTime()) });

function calendar(today: string, now: number) {
  return (
    <SettingsAndDays>
      <Calendar today={today} now={now} date={today} onOpen={vi.fn()} onReviewWeek={vi.fn()} />
    </SettingsAndDays>
  );
}

const picked = () => screen.getByRole('button', { pressed: true });

beforeEach(() => {
  vi.useFakeTimers({ now: LAST_EVENING });
  vi.mocked(api.getSettings).mockResolvedValue(answered(makeSettings()));
});

describe('Calendar', () => {
  it('keeps its month and picked day over midnight, and This month moves on', async () => {
    serveRange([clockedIn]);
    const view = render(calendar(LAST, LAST_EVENING));
    await settle();
    expect(screen.getByRole('group', { name: formatMonth(LAST) })).toBeTruthy();
    expect(picked().dataset.date).toBe(LAST);
    expect(picked().getAttribute('aria-current')).toBe('date');
    expect(screen.getByText('Worked')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'This month' })).toBeNull();

    view.rerender(calendar(FIRST, AFTER_MIDNIGHT));
    await settle();
    expect(screen.getByRole('group', { name: formatMonth(LAST) })).toBeTruthy();
    expect(picked().dataset.date).toBe(LAST);
    expect(screen.getByText('Worked')).toBeTruthy();
    expect(api.getRange).not.toHaveBeenCalledWith(FIRST, '2026-10-31');

    fireEvent.click(screen.getByRole('button', { name: 'This month' }));
    await settle();
    expect(api.getRange).toHaveBeenLastCalledWith(FIRST, '2026-10-31');
    expect(screen.getByRole('group', { name: formatMonth(FIRST) })).toBeTruthy();
    expect(screen.getByText('Tap a day to see it.')).toBeTruthy();
    // The reset in the header goes once pressed: the focus moves to Previous month.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Previous month' }));
  });

  it('hands the focus to Previous month when Next month reaches the current one and is disabled', async () => {
    serveRange([]);
    render(calendar(LAST, LAST_EVENING));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    await settle();
    // Into a month still before the current one: Next stays, and so does the focus.
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    await settle();
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    await settle();
    expect((screen.getByRole('button', { name: 'Next month' }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Previous month' }));
  });

  it('shows a failed load with Try again, which loads the month and hands the focus to Previous month', async () => {
    serveRange([clockedIn]);
    vi.mocked(api.getRange).mockRejectedValueOnce(new Error('Request failed (502)'));
    render(calendar(LAST, LAST_EVENING));
    await settle();
    expect(screen.getByRole('alert').textContent).toContain(LOAD_FAILED.range);
    fireEvent.click(screen.getByRole('button', { name: LOAD_FAILED.retry }));
    await settle();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('group', { name: formatMonth(LAST) })).toBeTruthy();
    expect(api.getRange).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Previous month' }));
  });

  it('reads a picked day with nothing on it as nothing recorded', async () => {
    // The store's copy of a day the server has no row for: padded punches and nothing else.
    serveRange([makeDay(LAST)]);
    render(calendar(LAST, LAST_EVENING));
    await settle();
    expect(picked().getAttribute('aria-label')).toMatch(/, nothing recorded$/);
    expect(screen.getByText('Nothing recorded.')).toBeTruthy();
    expect(screen.queryByText('Worked')).toBeNull();
  });

  it('shows Check punches for a day with punches out of order, in place of its hours', async () => {
    const at = (h: number) => new Date(2026, 8, 29, h).getTime();
    // Lunch in typed before lunch out.
    serveRange([makeDay('2026-09-29', { punches: punchesAt(at(9), at(12), at(11), at(17)) })]);
    const view = render(calendar(LAST, LAST_EVENING));
    await settle();
    const cell = view.container.querySelector<HTMLElement>('[data-date="2026-09-29"]')!;
    expect(cell.getAttribute('aria-label')).toMatch(/, check punches$/);
    expect(cell.querySelector('.calendar-worked')!.textContent).toBe('—');
    expect(cell.querySelector('.calendar-bar')).toBeNull();
    fireEvent.click(cell);
    expect(screen.getByText(CHECK_PUNCHES)).toBeTruthy();
    expect(screen.getByText('Worked').parentElement!.textContent).toContain('—');
  });

  it('drops a sticker filter whose reason leaves the legend', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(answered(makeSettings({ stickers: true })));
    const at = (h: number, m = 0) => new Date(2026, 8, 29, h, m).getTime();
    serveRange([makeDay('2026-09-29', { punches: punchesAt(at(8), at(12), at(12, 30), at(16, 30)) })]);
    const view = render(calendar(LAST, LAST_EVENING));
    await settle();
    const cell = () => view.container.querySelector('[data-date="2026-09-29"]')!.getAttribute('aria-label');
    expect(cell()).toMatch(/, Clocked out, Lunch taken$/);
    fireEvent.click(screen.getByRole('button', { name: /^Clocked out/ }));
    expect(cell()).toMatch(/, Clocked out$/);

    // Show hours turned off elsewhere: the next settings refresh takes the Clocked out chip away.
    vi.mocked(api.getSettings).mockResolvedValue(answered(makeSettings({ stickers: true, trackHours: false })));
    await settle(MINUTE_MS);
    expect(screen.queryByRole('button', { name: /^Clocked out/ })).toBeNull();
    expect(cell()).toMatch(/, Lunch taken$/);
    expect(screen.getByRole('button', { name: /^Lunch taken/ }).getAttribute('aria-pressed')).toBe('false');
  });
});
