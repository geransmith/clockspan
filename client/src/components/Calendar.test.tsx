// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { formatMonth } from '../lib/format';
import { emptyPunches } from '../lib/timeclock';
import { makeDay, makeSettings, SettingsAndDays, settle } from '../test/hooks';
import type { Day } from '../types';
import { Calendar } from './Calendar';

vi.mock('../api');

// The last day of a month, and the first of the next.
const LAST = '2026-09-30';
const FIRST = '2026-10-01';
const LAST_EVENING = new Date(2026, 8, 30, 17).getTime();
const AFTER_MIDNIGHT = new Date(2026, 9, 1, 0, 1).getTime();
const clockedIn = makeDay(LAST, { punches: emptyPunches().map((p) => (p.position === 0 ? { ...p, at: new Date(2026, 8, 30, 9).getTime() } : p)) });

/** The server answers a range with the days it holds in it. */
function serve(days: Day[]) {
  vi.mocked(api.getRange).mockImplementation((from, to) => Promise.resolve({ days: days.filter((d) => d.date >= from && d.date <= to) }));
}

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
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('Calendar', () => {
  it('keeps its month and picked day over midnight, and This month moves on', async () => {
    serve([clockedIn]);
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
  });

  it('reads a picked day with nothing on it as nothing recorded', async () => {
    // The store's copy of a day the server has no row for: padded punches and nothing else.
    serve([makeDay(LAST)]);
    render(calendar(LAST, LAST_EVENING));
    await settle();
    expect(picked().getAttribute('aria-label')).toMatch(/, nothing recorded$/);
    expect(screen.getByText('Nothing recorded.')).toBeTruthy();
    expect(screen.queryByText('Worked')).toBeNull();
  });
});
