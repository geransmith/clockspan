import { describe, expect, it } from 'vitest';
import { atTime, HOUR_MS, MINUTE_MS } from '../../../shared/dates.js';
import { makeDay, punchesAt, TEST_SETTINGS } from '../test/fixtures';
import type { Day } from '../types';
import { weekHours } from './week';

const settings = TEST_SETTINGS;
const TODAY = '2026-09-30'; // a Wednesday
const NOW = new Date(2026, 8, 30, 12, 0).getTime();

/** A day clocked in at 8:00 and out `hours` later, or still in when `hours` is null. */
function day(date: string, hours: number | null, patch: Partial<Day> = {}): Day {
  const start = atTime(date, 8, 0);
  return makeDay(date, { punches: punchesAt(start, null, null, hours == null ? null : start + hours * HOUR_MS), ...patch });
}

describe('weekHours', () => {
  it('adds up Monday to the day, today live, against the weekly target', () => {
    const days = [day('2026-09-28', 8), day('2026-09-29', 7.5), day(TODAY, null)];
    expect(weekHours(days, settings, TODAY, NOW)).toEqual({
      workedSeconds: (8 + 7.5 + 4) * 3600,
      targetSeconds: 40 * 3600,
      met: false,
      overSeconds: 0,
    });
  });

  it('stops a past day left clocked in at the end of that day, as its sheet does', () => {
    const open = day('2026-09-28', null);
    expect(weekHours([open], settings, TODAY, NOW).workedSeconds).toBe(16 * 3600 - 1);
  });

  it('reports a target of nothing when the week line is off', () => {
    expect(weekHours([], { ...settings, weekMinutes: 0 }, TODAY, NOW)).toEqual({ workedSeconds: 0, targetSeconds: 0, met: false, overSeconds: 0 });
    // Hours with no target are not over anything.
    expect(weekHours([day('2026-09-28', 8)], { ...settings, weekMinutes: 0 }, TODAY, NOW).overSeconds).toBe(0);
  });

  it('is met once the worked time reaches the target, not before', () => {
    const days = [day('2026-09-28', 8), day('2026-09-29', 8)];
    expect(weekHours(days, { ...settings, weekMinutes: 16 * 60 }, TODAY, NOW).met).toBe(true);
    expect(weekHours(days, { ...settings, weekMinutes: 16 * 60 + 1 }, TODAY, NOW).met).toBe(false);
  });

  it('counts the time past the target once it is a whole minute', () => {
    // Today, clocked in at 8:00: four hours at noon, against a four-hour week.
    const days = [day(TODAY, null)];
    const four = { ...settings, weekMinutes: 4 * 60 };
    expect(weekHours(days, four, TODAY, NOW)).toMatchObject({ met: true, overSeconds: 0 });
    expect(weekHours(days, four, TODAY, NOW + 59_000).overSeconds).toBe(0);
    expect(weekHours(days, four, TODAY, NOW + MINUTE_MS).overSeconds).toBe(60);
    expect(weekHours(days, four, TODAY, NOW + 90 * MINUTE_MS).overSeconds).toBe(90 * 60);
  });
});
