import { describe, expect, it } from 'vitest';
import type { DaySummary } from '../types';
import { calendarMonth } from './calendar';
import { emptyPunches } from './timeclock';

const settings = { workMinutes: 480, lunchDeadlineMinutes: 300, lunchMinutes: 30, secondMealAfterMinutes: 600 };
const TODAY = '2026-09-17'; // a Thursday
const NOW = new Date(2026, 8, 17, 15, 0).getTime();
const summary = (date: string, patch: Partial<DaySummary> = {}): DaySummary => ({ date, punches: emptyPunches(), focusSeconds: 0, prioritiesDone: 0, prioritiesTotal: 0, retroAt: null, ...patch });

describe('calendarMonth', () => {
  it('pads the month to Monday-start weeks and places the days with their stickers', () => {
    const weeks = calendarMonth([summary('2026-09-14', { retroAt: 1 }), summary('2026-08-31', { focusSeconds: 10 })], settings, TODAY, NOW, '2026-09-01');
    expect(weeks).toHaveLength(5);
    expect(weeks.map((w) => w.length)).toEqual([7, 7, 7, 7, 7]);
    expect(weeks[0]![0]).toEqual({ date: '2026-08-31', outside: true, isFuture: false, hasData: false, stickers: [] }); // a filler never shows data
    expect(weeks[0]![1]).toEqual({ date: '2026-09-01', outside: false, isFuture: false, hasData: false, stickers: [] });
    expect(weeks[2]![0]).toEqual({ date: '2026-09-14', outside: false, isFuture: false, hasData: true, stickers: ['reviewed'] });
    expect(weeks[2]![3]!.isFuture).toBe(false); // today
    expect(weeks[2]![4]!.isFuture).toBe(true);
    expect(weeks[4]![2]!.date).toBe('2026-09-30');
    expect(weeks[4]![3]).toMatchObject({ date: '2026-10-01', outside: true });
  });

  it('needs no filler when the month starts on a Monday and ends on a Sunday', () => {
    const weeks = calendarMonth([], settings, '2027-03-01', NOW, '2027-02-01');
    expect(weeks).toHaveLength(4);
    expect(weeks[0]![0]!.date).toBe('2027-02-01');
    expect(weeks[3]![6]!.date).toBe('2027-02-28');
    expect(weeks.flat().some((d) => d.outside)).toBe(false);
  });
});
