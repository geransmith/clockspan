import { describe, expect, it } from 'vitest';
import { calendarMonth, pickedTimeclock } from './calendar';
import { dayTimeclock, type DaySummary } from './stickers';
import { emptyPunches } from './timeclock';

const settings = { workMinutes: 480, lunchDeadlineMinutes: 300, lunchMinutes: 30, secondMealAfterMinutes: 600 };
const TODAY = '2026-09-17'; // a Thursday
const NOW = new Date(2026, 8, 17, 15, 0).getTime();
const summary = (date: string, patch: Partial<DaySummary> = {}): DaySummary => ({
  date,
  punches: emptyPunches(),
  focusSeconds: 0,
  focusSessions: 0,
  prioritiesDone: 0,
  prioritiesTotal: 0,
  retroAt: null,
  workMinutes: null,
  ...patch,
});

describe('calendarMonth', () => {
  it('pads the month to Monday-start weeks and places the days with their stickers', () => {
    const weeks = calendarMonth([summary('2026-09-14', { retroAt: 1 }), summary('2026-08-31', { focusSeconds: 10 })], settings, TODAY, NOW, '2026-09-01');
    expect(weeks).toHaveLength(5);
    expect(weeks.map((w) => w.length)).toEqual([7, 7, 7, 7, 7]);
    expect(weeks[0]![0]).toEqual({ date: '2026-08-31', outside: true, isFuture: false, hasData: false, stickers: [], timeclock: null }); // a filler never shows data
    expect(weeks[0]![1]).toEqual({ date: '2026-09-01', outside: false, isFuture: false, hasData: false, stickers: [], timeclock: null });
    expect(weeks[2]![0]).toMatchObject({ date: '2026-09-14', outside: false, isFuture: false, hasData: true, stickers: ['reviewed'] });
    // The day's timeclock comes along, worked out once for the stickers, the cell and the panel.
    expect(weeks[2]![0]!.timeclock).toMatchObject({ state: 'not-started', clockIn: null });
    expect(weeks[2]![3]!.isFuture).toBe(false); // today
    expect(weeks[2]![4]!.isFuture).toBe(true);
    expect(weeks[4]![2]!.date).toBe('2026-09-30');
    expect(weeks[4]![3]).toMatchObject({ date: '2026-10-01', outside: true });
  });

  it('drops Saturday and Sunday, and what they earned, when weekends are off', () => {
    const days = [summary('2026-09-12', { retroAt: 1 }), summary('2026-09-14', { retroAt: 1 })]; // a Saturday and a Monday
    const weeks = calendarMonth(days, settings, TODAY, NOW, '2026-09-01', false);
    expect(weeks).toHaveLength(5);
    expect(weeks.map((w) => w.length)).toEqual([5, 5, 5, 5, 5]);
    expect(weeks.flat().map((d) => d.date)).not.toContain('2026-09-12');
    expect(weeks[1]![4]!.date).toBe('2026-09-11');
    expect(weeks[2]![0]).toMatchObject({ date: '2026-09-14', stickers: ['reviewed'] });
    expect(
      weeks
        .flat()
        .filter((d) => d.stickers.length)
        .map((d) => d.date),
    ).toEqual(['2026-09-14']);
    // August 2026 starts on a Saturday: its first work week is the 3rd, not a row of filler.
    const august = calendarMonth([], settings, TODAY, NOW, '2026-08-01', false);
    expect(august[0]![0]!.date).toBe('2026-08-03');
    expect(august).toHaveLength(5);
    expect(august[4]![0]!.date).toBe('2026-08-31'); // a Monday alone in its row
  });

  it('needs no filler when the month starts on a Monday and ends on a Sunday', () => {
    const weeks = calendarMonth([], settings, '2027-03-01', NOW, '2027-02-01');
    expect(weeks).toHaveLength(4);
    expect(weeks[0]![0]!.date).toBe('2027-02-01');
    expect(weeks[3]![6]!.date).toBe('2027-02-28');
    expect(weeks.flat().some((d) => d.outside)).toBe(false);
  });
});

describe('pickedTimeclock', () => {
  const at = (h: number) => new Date(2026, 8, 12, h, 0).getTime();
  // A Saturday clocked 9:00 to 12:00, and a Monday with a cell.
  const saturday = summary('2026-09-12', {
    punches: emptyPunches().map((p) => (p.position === 0 ? { ...p, at: at(9) } : p.position === 3 ? { ...p, at: at(12) } : p)),
  });
  const monday = summary('2026-09-14', { retroAt: 1 });

  it("takes the picked day's cell's timeclock", () => {
    const weeks = calendarMonth([saturday, monday], settings, TODAY, NOW, '2026-09-01');
    expect(pickedTimeclock(weeks, monday, settings, TODAY, NOW)).toBe(weeks[2]![0]!.timeclock);
    expect(pickedTimeclock(weeks, saturday, settings, TODAY, NOW)).toBe(weeks[1]![5]!.timeclock);
  });

  it('works out a weekend day that has no cell with weekends off', () => {
    // History opens on the sheet's date, so a Saturday can be picked with no cell to read.
    const weeks = calendarMonth([saturday, monday], settings, TODAY, NOW, '2026-09-01', false);
    const tc = pickedTimeclock(weeks, saturday, settings, TODAY, NOW);
    expect(tc).toEqual(dayTimeclock(saturday, settings, TODAY, NOW));
    expect(tc).toMatchObject({ state: 'done', workedSeconds: 3 * 3600 });
  });
});
