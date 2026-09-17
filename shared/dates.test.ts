import { describe, expect, it } from 'vitest';
import { addDays, addMonths, endOfDay, isValidDateKey, parseDateKey, punchWindow, startOfMonth, startOfQuarter, startOfWeek } from './dates.js';

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
  it('walks days across month and year ends', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
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
  });

  it('ends the day one millisecond before the next one starts', () => {
    expect(endOfDay('2026-09-16')).toBe(parseDateKey('2026-09-17').getTime() - 1);
  });
});

describe('punchWindow', () => {
  it('spans a day of slack either side of the key, in UTC, so any zone\'s local day fits', () => {
    const { from, to } = punchWindow('2026-09-01');
    const midnightUtc = Date.UTC(2026, 8, 1);
    expect(from).toBe(midnightUtc - 36 * 3_600_000);
    expect(to).toBe(midnightUtc + 60 * 3_600_000);
    // The extremes: local midnight in UTC+14 and the last millisecond of the day in UTC-12.
    expect(midnightUtc - 14 * 3_600_000).toBeGreaterThanOrEqual(from);
    expect(midnightUtc + 36 * 3_600_000 - 1).toBeLessThanOrEqual(to);
    expect(to - from).toBe(96 * 3_600_000);
  });
});
