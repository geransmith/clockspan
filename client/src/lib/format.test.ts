import { describe, expect, it } from 'vitest';
import {
  dayName,
  formatCountdown,
  formatDateFull,
  formatDateShort,
  formatDuration,
  formatDurationCeil,
  formatTime,
  formatWeekday,
  resolveHour12,
  roundToMinute,
} from './format';

describe('dayName', () => {
  it('names today and yesterday, and dates everything else', () => {
    expect(dayName('2026-09-16', '2026-09-16')).toBe('Today');
    expect(dayName('2026-09-15', '2026-09-16')).toBe('Yesterday');
    expect(dayName('2026-09-14', '2026-09-16')).toMatch(/14/);
    expect(dayName('2026-09-17', '2026-09-16')).toMatch(/17/);
  });
});

describe('dates', () => {
  it('writes the full date with its weekday and year, and the weekday alone', () => {
    // The runner's locale picks the spelling; the parts have to be there, on the local day.
    expect(formatDateFull('2026-09-16')).toMatch(/2026/);
    expect(formatDateFull('2026-09-16')).toMatch(/16/);
    expect(formatWeekday('2026-09-16')).toBe(new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(2026, 8, 16)));
    // The short date carries the day and month and nothing of the weekday, in any locale.
    const short = formatDateShort('2026-09-16');
    expect(short).toBe(new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(2026, 8, 16)));
    expect(short).not.toContain(formatWeekday('2026-09-16'));
  });

  it('rounds an instant to the nearest minute', () => {
    const at = new Date(2026, 8, 16, 7, 5, 29).getTime();
    expect(roundToMinute(at)).toBe(new Date(2026, 8, 16, 7, 5).getTime());
    expect(roundToMinute(at + 1000)).toBe(new Date(2026, 8, 16, 7, 6).getTime());
  });
});

describe('durations', () => {
  it('formats minutes and hours', () => {
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(45 * 60)).toBe('45m');
    expect(formatDuration(3600 + 12 * 60)).toBe('1h 12m');
    expect(formatDuration(-90)).toBe('1m');
  });

  it('rounds up so a countdown never reads 0m with seconds left', () => {
    expect(formatDurationCeil(1)).toBe('1m');
    expect(formatDurationCeil(61)).toBe('2m');
  });

  it('formats a countdown as mm:ss or h:mm:ss', () => {
    expect(formatCountdown(59)).toBe('0:59');
    expect(formatCountdown(25 * 60)).toBe('25:00');
    expect(formatCountdown(3661)).toBe('1:01:01');
    expect(formatCountdown(-83)).toBe('−1:23');
    expect(formatCountdown(-0.4)).toBe('0:00');
  });
});

describe('formatTime', () => {
  const at = new Date(2026, 8, 16, 7, 5).getTime();
  it('writes the 12-hour and 24-hour clocks whatever the runner locale', () => {
    expect(formatTime(at, true)).toMatch(/^7:05\s?[AaPp]/);
    expect(formatTime(at, false)).toMatch(/^0?7:05$/);
    expect(formatTime(new Date(2026, 8, 16, 0, 0).getTime(), false)).toMatch(/^0?0:00$/);
  });

  it('resolves the fixed formats and falls back to the locale for auto', () => {
    expect(resolveHour12('12h')).toBe(true);
    expect(resolveHour12('24h')).toBe(false);
    expect(typeof resolveHour12('auto')).toBe('boolean');
  });
});
