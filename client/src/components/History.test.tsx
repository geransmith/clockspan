// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { formatDateLong, formatMonth } from '../lib/format';
import type { ReviewPeriod } from '../lib/review';
import { makeDay, makeSettings, serveRange, SettingsAndDays, settle } from '../test/hooks';
import { History } from './History';

vi.mock('../api');

const TODAY = '2026-09-30';
const NOW = new Date(2026, 8, 30, 17).getTime();
const AUGUST_DAY = makeDay('2026-08-14', { retroNote: 'The report ran long' });
const JULY_DAY = makeDay('2026-07-14', { retroNote: 'Meetings took the afternoon' });

async function history(date: string, review: ReviewPeriod | null = null) {
  const onOpen = vi.fn();
  render(
    <SettingsAndDays>
      <History today={TODAY} now={NOW} date={date} review={review} onOpen={onOpen} />
    </SettingsAndDays>,
  );
  await settle();
  return onOpen;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings());
  serveRange([AUGUST_DAY, JULY_DAY]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('History', () => {
  it("keeps the calendar's month and picked day across a switch to Review and back", async () => {
    await history(TODAY);
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    await settle();
    const august = () => screen.getByRole('group', { name: formatMonth(AUGUST_DAY.date) });
    fireEvent.click(within(august()).getByRole('button', { name: new RegExp(`^${formatDateLong(AUGUST_DAY.date)},`) }));

    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    await settle();
    expect(screen.queryByRole('group', { name: formatMonth(AUGUST_DAY.date) })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Days' }));
    expect(within(august()).getByRole('button', { pressed: true }).dataset.date).toBe(AUGUST_DAY.date);
  });

  it('opens Review on the period a day was opened from, and sends that period with the next day opened', async () => {
    const period: ReviewPeriod = { kind: 'month', from: '2026-07-01' };
    const onOpen = await history(JULY_DAY.date, period);
    expect(screen.getByRole('button', { name: 'Review', pressed: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Month', pressed: true })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Meetings took the afternoon/ }));
    expect(onOpen).toHaveBeenCalledWith(JULY_DAY.date, period);
  });

  it('sends the period stepped to in Review, not the one History opened on', async () => {
    const onOpen = await history(TODAY);
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Month' }));
    await settle();
    // The hidden calendar's own Previous month is left out of role queries.
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /The report ran long/ }));
    expect(onOpen).toHaveBeenCalledWith(AUGUST_DAY.date, { kind: 'month', from: '2026-08-01' });
  });

  it('opens a day picked on Days with no review period', async () => {
    const onOpen = await history(AUGUST_DAY.date);
    fireEvent.click(screen.getByRole('button', { name: 'Open day' }));
    expect(onOpen).toHaveBeenCalledWith(AUGUST_DAY.date, null);
  });
});
