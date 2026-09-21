import { Time } from '@internationalized/date';
import { describe, expect, it } from 'vitest';
import { guessPeriod, msToTime, timeToMs } from './timefield';

const DAY = '2026-09-16';
const at = (h: number, m: number) => new Date(2026, 8, 16, h, m).getTime();

describe('msToTime / timeToMs', () => {
  it('round-trips a local time on the given day and drops seconds', () => {
    const t = msToTime(at(8, 5) + 42_000);
    expect(t).toEqual(new Time(8, 5));
    expect(timeToMs(t!, DAY)).toBe(at(8, 5));
    expect(msToTime(null)).toBeNull();
  });

  it("places the time on the date key, not on the instant's own day", () => {
    expect(timeToMs(new Time(7, 30), '2026-09-17')).toBe(new Date(2026, 8, 17, 7, 30).getTime());
  });
});

describe('guessPeriod', () => {
  it('reads working hours as a day job without an anchor', () => {
    const cases: [number, 'AM' | 'PM'][] = [
      [5, 'AM'],
      [7, 'AM'],
      [11, 'AM'],
      [12, 'PM'],
      [1, 'PM'],
      [4, 'PM'],
    ];
    for (const [h, p] of cases) expect(guessPeriod(h, 0, DAY, null), `${h}`).toBe(p);
  });

  it('keeps a later punch after the clock-in when only the other period does', () => {
    const clockIn = at(7, 30);
    expect(guessPeriod(10, 0, DAY, clockIn)).toBe('AM'); // 10:00 AM is after 7:30 AM already
    expect(guessPeriod(12, 30, DAY, clockIn)).toBe('PM');
    expect(guessPeriod(4, 0, DAY, clockIn)).toBe('PM');
    expect(guessPeriod(6, 0, DAY, clockIn)).toBe('PM'); // 6:00 AM is before the clock-in, 6:00 PM after
    expect(guessPeriod(7, 0, DAY, clockIn)).toBe('PM'); // 7:00 AM is 30 min before the clock-in
    expect(guessPeriod(7, 30, DAY, clockIn)).toBe('AM'); // exactly the clock-in counts as after
  });

  it('keeps the base guess when neither period lands after the anchor', () => {
    expect(guessPeriod(9, 0, DAY, at(23, 0))).toBe('AM');
  });
});
