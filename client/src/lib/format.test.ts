import { describe, expect, it } from 'vitest';
import {
  dayName,
  formatCountdown,
  formatDateFull,
  formatDateSpan,
  formatDuration,
  formatDurationCeil,
  formatHours,
  formatMinutes,
  formatMonth,
  formatTime,
  formatWeekday,
  resolveHour12,
  floorToMinute,
  plural,
  sameText,
} from './format';

describe('dayName', () => {
  it('names today, yesterday and tomorrow, and dates everything else', () => {
    expect(dayName('2026-09-16', '2026-09-16')).toBe('Today');
    expect(dayName('2026-09-15', '2026-09-16')).toBe('Yesterday');
    expect(dayName('2026-09-17', '2026-09-16')).toBe('Tomorrow');
    expect(dayName('2026-09-14', '2026-09-16')).toMatch(/14/);
    expect(dayName('2026-09-18', '2026-09-16')).toMatch(/18/);
  });

  it('lowercases the word inside a sentence, never the date', () => {
    expect(dayName('2026-09-15', '2026-09-16', true)).toBe('yesterday');
    expect(dayName('2026-09-17', '2026-09-16', true)).toBe('tomorrow');
    expect(dayName('2026-09-18', '2026-09-16', true)).toBe(dayName('2026-09-18', '2026-09-16'));
  });
});

describe('dates', () => {
  it('writes the full date with its weekday and year, and the weekday alone', () => {
    // The runner's locale picks the spelling; the parts have to be there, on the local day.
    expect(formatDateFull('2026-09-16')).toMatch(/2026/);
    expect(formatDateFull('2026-09-16')).toMatch(/16/);
    expect(formatWeekday('2026-09-16')).toBe(new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(2026, 8, 16)));
  });

  it("writes the period labels in the locale's own patterns", () => {
    // Compared with Intl itself: the spacing around the dash and the day-month order are the locale's.
    expect(formatMonth('2026-09-16')).toBe(new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date(2026, 8, 16)));
    const span = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
    expect(formatDateSpan('2026-09-14', '2026-09-20')).toBe(span.formatRange(new Date(2026, 8, 14), new Date(2026, 8, 20)));
    expect(formatDateSpan('2026-09-28', '2026-10-04')).toBe(span.formatRange(new Date(2026, 8, 28), new Date(2026, 9, 4)));
    // Across New Year the locale adds the years.
    expect(formatDateSpan('2025-12-29', '2026-01-04')).toBe(span.formatRange(new Date(2025, 11, 29), new Date(2026, 0, 4)));
    expect(formatDateSpan('2025-12-29', '2026-01-04')).toMatch(/2026/);
  });

  it('takes an instant down to the start of its minute, never later', () => {
    const minute = new Date(2026, 8, 16, 7, 5).getTime();
    expect(floorToMinute(minute)).toBe(minute);
    expect(floorToMinute(minute + 59_999)).toBe(minute);
    expect(floorToMinute(minute + 60_000)).toBe(minute + 60_000);
  });
});

describe('durations', () => {
  it('formats minutes and hours', () => {
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(45 * 60)).toBe('45m');
    expect(formatDuration(3600 + 12 * 60)).toBe('1h 12m');
    expect(formatDuration(-90)).toBe('1m');
  });

  it('writes a length in minutes the way the alarm banners do', () => {
    expect(formatMinutes(15)).toBe('15 min');
    expect(formatMinutes(60)).toBe('1h');
    expect(formatMinutes(90)).toBe('1h 30m');
    expect(formatMinutes(605)).toBe('10h 5m');
  });

  it('writes hours and minutes on one line', () => {
    expect(formatHours(0)).toBe('0:00');
    expect(formatHours(45 * 60)).toBe('0:45');
    expect(formatHours(7 * 3600 + 39 * 60 + 29)).toBe('7:39');
    expect(formatHours(10 * 3600 + 5 * 60)).toBe('10:05');
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

describe('words', () => {
  it('picks one or many by the count', () => {
    expect(`1 ${plural(1, 'day')}`).toBe('1 day');
    expect(`0 ${plural(0, 'day')}`).toBe('0 days');
    expect(`3 ${plural(3, 'entry', 'entries')}`).toBe('3 entries');
  });

  it('keys text by its words, whatever the case or spacing', () => {
    expect(sameText('  Call   the\tBank ')).toBe('call the bank');
    expect(sameText('Call the bank')).toBe(sameText('call THE bank'));
  });
});
