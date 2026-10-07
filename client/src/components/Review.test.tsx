// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atTime } from '../../../shared/dates.js';
import * as api from '../api';
import { LOAD_FAILED } from '../lib/copy';
import type { ReviewPeriod } from '../lib/review';
import { completedSession, makeBreak, makeDay, makePriority, makeSettings, punchesAt, serveRange, SettingsAndDays, settle } from '../test/hooks';
import { Review } from './Review';

vi.mock('../api');

const TODAY = '2026-09-30';
const NOW = new Date(2026, 8, 30, 17).getTime();
const MON = '2026-09-28';
const TUE = '2026-09-29';

/**
 * Monday: 8 h worked, 50m on the first row and 10m off the plan, a 10-minute break, and a second
 * row written at 11:00, after the first session. Tuesday: a 4 h half day clocked out an hour
 * early, with three rows written before work and one ticked, and no sessions.
 */
const mon = makeDay(MON, {
  punches: punchesAt(atTime(MON, 8, 0), atTime(MON, 12, 0), atTime(MON, 12, 30), atTime(MON, 16, 30)),
  priorities: [makePriority(1, 'Ship it', { done: true, addedAt: 0 }), makePriority(2, 'Call the bank', { addedAt: atTime(MON, 11, 0) })],
  sessions: [
    completedSession(1, atTime(MON, 9, 0), 3000, { date: MON, priorityUid: makePriority(1, '').uid }),
    completedSession(2, atTime(MON, 14, 0), 600, { date: MON }),
  ],
  breaks: [makeBreak({ date: MON, plannedSeconds: 600, startedAt: atTime(MON, 9, 50), endedAt: atTime(MON, 10, 0) })],
});
const tue = makeDay(TUE, {
  workMinutes: 240,
  punches: punchesAt(atTime(TUE, 8, 0), null, null, atTime(TUE, 11, 0)),
  priorities: [
    makePriority(1, 'Write the report', { addedAt: 0 }),
    makePriority(2, 'File expenses', { done: true, addedAt: 0 }),
    makePriority(3, 'Plan Q4', { addedAt: 0 }),
  ],
});

/** The facts strip's lines, in order. */
const facts = () => [...document.querySelectorAll('.review-facts li')].map((li) => li.textContent);

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

  it('holds a week to the Work week, counts its sessions and lists the facts under the tiles', async () => {
    serveRange([mon, tue]);
    await review({ kind: 'week', from: MON });
    // The half day doesn't lower a week's target.
    expect(screen.getByText('worked 11h 00m of 40h 00m')).toBeTruthy();
    expect(screen.getByText('2 sessions · 83% on plan')).toBeTruthy();
    expect(facts()).toEqual(['Added mid-day: 1 · 0 done', 'Breaks: 1 · 10m', 'Typical day: 3 planned · 1 done']);
    // Straight after the tiles, before Off the plan.
    expect(document.querySelector('.tiles + .review-facts + .review-section')).not.toBeNull();
  });

  it("holds a month or a quarter to its days' own lengths, and leaves the typical day out of a quarter", async () => {
    serveRange([mon, tue]);
    await review({ kind: 'month', from: '2026-09-01' });
    // 8 h and the half day's 4 h, though Tuesday worked 3 h of its 4.
    expect(screen.getByText('worked 11h 00m of 12h 00m')).toBeTruthy();
    expect(facts()).toEqual(['Added mid-day: 1 · 0 done', 'Breaks: 1 · 10m', 'Typical day: 3 planned · 1 done']);
    cleanup();

    await review({ kind: 'quarter', from: '2026-07-01' });
    expect(screen.getByText('worked 11h 00m of 12h 00m')).toBeTruthy();
    expect(facts()).toEqual(['Added mid-day: 1 · 0 done', 'Breaks: 1 · 10m']);
  });

  it('counts a session that logged no time, with no on-plan share', async () => {
    // Finished within its first second: the server logs 0 seconds.
    const start = atTime(MON, 9, 0);
    const uid = makePriority(1, '').uid;
    serveRange([
      makeDay(MON, {
        priorities: [makePriority(1, 'Ship it')],
        sessions: [completedSession(1, start, 1500, { date: MON, priorityUid: uid, endedAt: start, durationSeconds: 0 })],
      }),
    ]);
    await review({ kind: 'week', from: MON });
    expect(screen.getByText('Focused').parentElement?.querySelector('.tile-sub')?.textContent).toBe('1 session');
    expect(screen.getByText('Every logged session was for a priority.')).toBeTruthy();
    expect(screen.queryByText('No sessions logged.')).toBeNull();
  });

  it('drops the target with no Work week, the hours with Show hours off, and the facts strip with nothing in it', async () => {
    serveRange([makeDay(MON, { punches: punchesAt(atTime(MON, 8, 0), null, null, atTime(MON, 12, 0)) })]);
    vi.mocked(api.getSettings).mockResolvedValue(makeSettings({ weekMinutes: 0 }));
    await review({ kind: 'week', from: MON });
    expect(screen.getByText('worked 4h 00m')).toBeTruthy();
    expect(screen.getByText('no sessions')).toBeTruthy();
    expect(document.querySelector('.review-facts')).toBeNull();
    cleanup();

    vi.mocked(api.getSettings).mockResolvedValue(makeSettings({ trackHours: false }));
    await review({ kind: 'week', from: MON });
    expect(screen.getByText('Days')).toBeTruthy();
    expect(screen.queryByText(/^worked/)).toBeNull();
  });
});
