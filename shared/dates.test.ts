import { describe, expect, it, vi } from 'vitest';
import {
  addDays,
  addMonths,
  atTime,
  daysBetween,
  endOfDay,
  HOUR_MS,
  isValidDateKey,
  isWeekend,
  parseDateKey,
  punchWindow,
  startOfMonth,
  startOfQuarter,
  startOfWeek,
  todayKey,
} from './dates.js';

describe('isValidDateKey', () => {
  it('accepts real calendar dates only', () => {
    expect(isValidDateKey('2026-09-16')).toBe(true);
    expect(isValidDateKey('2024-02-29')).toBe(true);
    expect(isValidDateKey('2025-02-29')).toBe(false);
    expect(isValidDateKey('2026-04-31')).toBe(false);
    expect(isValidDateKey('2026-13-01')).toBe(false);
    expect(isValidDateKey('2026-9-16')).toBe(false);
    expect(isValidDateKey('2026-09-16T00:00')).toBe(false);
    expect(isValidDateKey(20260916)).toBe(false);
    expect(isValidDateKey(null)).toBe(false);
  });
});

describe('date arithmetic', () => {
  it('walks days across month and year ends and the DST changes', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2026-03-09', -1)).toBe('2026-03-08');
    expect(addDays('2026-10-31', 2)).toBe('2026-11-02');
  });

  it('counts whole days between two keys, across year ends, leap days and the DST changes', () => {
    expect(daysBetween('2026-09-16', '2026-09-16')).toBe(0);
    expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1);
    // The pinned zone's DST changes: a 23 h and a 25 h day still count as one each.
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
    expect(daysBetween('2026-10-31', '2026-11-02')).toBe(2);
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2);
    expect(daysBetween('2026-03-09', '2026-03-07')).toBe(-2);
  });

  it('tells a weekend from a weekday', () => {
    expect(isWeekend('2026-09-26')).toBe(true); // Saturday
    expect(isWeekend('2026-09-27')).toBe(true); // Sunday
    expect(isWeekend('2026-09-28')).toBe(false); // Monday
  });

  it('finds the start of the week (Monday), month and quarter', () => {
    expect(startOfWeek('2026-09-16')).toBe('2026-09-14'); // a Wednesday
    expect(startOfWeek('2026-09-14')).toBe('2026-09-14');
    expect(startOfWeek('2026-09-20')).toBe('2026-09-14'); // Sunday belongs to the week before
    expect(startOfMonth('2026-09-16')).toBe('2026-09-01');
    expect(startOfQuarter('2026-09-16')).toBe('2026-07-01');
    expect(startOfQuarter('2026-12-31')).toBe('2026-10-01');
  });

  it('steps months from the first and clamps to a first-of-month key', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-01');
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-01');
    expect(addMonths('2026-11-01', 3)).toBe('2027-02-01');
    expect(addMonths('2026-09-16', 0)).toBe('2026-09-01');
  });

  it('ends the day one millisecond before the next one starts, on a 23 h or 25 h day too', () => {
    const hours = (key: string) => (endOfDay(key) + 1 - parseDateKey(key).getTime()) / HOUR_MS;
    // These rely on the zone pinned in vite.config.ts (test.env) and fail in UTC.
    expect(hours('2026-03-08')).toBe(23);
    expect(hours('2026-11-01')).toBe(25);
    vi.stubEnv('TZ', 'America/Santiago');
    try {
      // Chile moves its clocks at 00:00, so this day starts at 01:00.
      expect(hours('2026-09-06')).toBe(23);
      expect(todayKey(endOfDay('2026-09-06'))).toBe('2026-09-06');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('atTime', () => {
  it("places a wall-clock time on the key's local date", () => {
    expect(atTime('2026-09-17', 7, 30)).toBe(new Date(2026, 8, 17, 7, 30).getTime());
  });

  it('moves a time in the hour the clocks skip forward an hour', () => {
    // This relies on the zone pinned in vite.config.ts (test.env) and fails in UTC.
    expect(atTime('2026-03-08', 2, 30)).toBe(new Date(2026, 2, 8, 3, 30).getTime());
  });
});

describe('punchWindow', () => {
  it("spans the key's UTC noon ± 48 h, in UTC, so any zone's local day fits", () => {
    const { from, to } = punchWindow('2026-09-01');
    const midnightUtc = Date.UTC(2026, 8, 1);
    // The extremes: local midnight in UTC+14 and the last millisecond of the day in UTC-12.
    expect(midnightUtc - 14 * HOUR_MS).toBeGreaterThanOrEqual(from);
    expect(midnightUtc + 36 * HOUR_MS - 1).toBeLessThanOrEqual(to);
    // The window is the key's UTC noon ± 48 h: 22 h to spare before the early extreme, 24 h after the late one.
    expect({ from, to }).toEqual({ from: midnightUtc - 36 * HOUR_MS, to: midnightUtc + 60 * HOUR_MS });
  });
});

describe('todayKey', () => {
  it('is the local date of the instant, now by default', () => {
    expect(todayKey(new Date(2026, 8, 16, 23, 59).getTime())).toBe('2026-09-16');
    expect(todayKey()).toBe(todayKey(Date.now()));
  });
});
