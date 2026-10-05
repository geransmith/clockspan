// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { LOAD_FAILED } from '../lib/copy';
import type { ReviewPeriod } from '../lib/review';
import { makeSettings, SettingsAndDays, settle } from '../test/hooks';
import { Review } from './Review';

vi.mock('../api');

const TODAY = '2026-09-30';
const NOW = new Date(2026, 8, 30, 17).getTime();

async function review(period: ReviewPeriod) {
  const onPeriod = vi.fn();
  render(
    <SettingsAndDays>
      <Review today={TODAY} now={NOW} period={period} onPeriod={onPeriod} onOpen={vi.fn()} />
    </SettingsAndDays>,
  );
  await settle();
  return onPeriod;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings());
  vi.mocked(api.getRange).mockResolvedValue({ days: [] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Review', () => {
  it('shows a failed load with Try again, which loads the review', async () => {
    vi.mocked(api.getRange).mockRejectedValueOnce(new Error('Request failed (502)'));
    await review({ kind: 'week', from: '2026-09-28' });
    expect(screen.getByRole('alert').textContent).toContain(LOAD_FAILED.range);
    fireEvent.click(screen.getByRole('button', { name: LOAD_FAILED.retry }));
    await settle();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Nothing recorded.')).toBeTruthy();
    expect(api.getRange).toHaveBeenCalledTimes(2);
  });

  it('turns a past week into the month it ends in', async () => {
    // Monday 29 June to Sunday 5 July: the month it starts in would be June.
    const onPeriod = await review({ kind: 'week', from: '2026-06-29' });
    fireEvent.click(screen.getByRole('button', { name: 'Month' }));
    expect(onPeriod).toHaveBeenCalledWith({ kind: 'month', from: '2026-07-01' });
  });

  it('keeps the current period current when the kind changes', async () => {
    // This week runs into October; its month is still September, the month today is in.
    const fromWeek = await review({ kind: 'week', from: '2026-09-28' });
    fireEvent.click(screen.getByRole('button', { name: 'Month' }));
    expect(fromWeek).toHaveBeenCalledWith({ kind: 'month', from: '2026-09-01' });
    cleanup();

    const fromMonth = await review({ kind: 'month', from: '2026-09-01' });
    fireEvent.click(screen.getByRole('button', { name: 'Week' }));
    expect(fromMonth).toHaveBeenCalledWith({ kind: 'week', from: '2026-09-28' });
  });

  it('steps from the period on screen and resets to the current one', async () => {
    const onPeriod = await review({ kind: 'week', from: '2026-07-13' });
    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    expect(onPeriod).toHaveBeenLastCalledWith({ kind: 'week', from: '2026-07-06' });
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    expect(onPeriod).toHaveBeenLastCalledWith({ kind: 'week', from: '2026-07-20' });
    fireEvent.click(screen.getByRole('button', { name: 'This week' }));
    expect(onPeriod).toHaveBeenLastCalledWith({ kind: 'week', from: '2026-09-28' });
    cleanup();

    // The current period has no next and no reset.
    await review({ kind: 'quarter', from: '2026-07-01' });
    expect((screen.getByRole('button', { name: 'Next quarter' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'This quarter' })).toBeNull();
  });
});
