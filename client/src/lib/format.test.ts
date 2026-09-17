import { describe, expect, it } from 'vitest';
import { dayName, formatCountdown, formatDuration, formatDurationCeil, fromTimeInput, toTimeInput } from './format';

describe('dayName', () => {
  it('names today and yesterday, and dates everything else', () => {
    expect(dayName('2026-09-16', '2026-09-16')).toBe('Today');
    expect(dayName('2026-09-15', '2026-09-16')).toBe('Yesterday');
    expect(dayName('2026-09-14', '2026-09-16')).toMatch(/14/);
    expect(dayName('2026-09-17', '2026-09-16')).toMatch(/17/);
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
  });
});

describe('<input type=time> conversions', () => {
  it('round-trips a local time on the given day', () => {
    const ms = fromTimeInput('2026-09-16', '08:05');
    expect(ms).toBe(new Date(2026, 8, 16, 8, 5).getTime());
    expect(toTimeInput(ms)).toBe('08:05');
    expect(toTimeInput(null)).toBe('');
    expect(fromTimeInput('2026-09-16', '')).toBeNull();
  });
});
