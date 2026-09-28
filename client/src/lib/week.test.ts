import { describe, expect, it } from 'vitest';
import type { Day, Punch } from '../types';
import { emptyPunches } from './timeclock';
import { weekHours } from './week';

const settings = { workMinutes: 480, lunchDeadlineMinutes: 300, lunchMinutes: 30, secondMealAfterMinutes: 600, weekMinutes: 2400 };
const H = 3_600_000;
const TODAY = '2026-09-30'; // a Wednesday
const NOW = new Date(2026, 8, 30, 12, 0).getTime();

/** A day clocked in at 8:00 and out `hours` later, or still in when `hours` is null. */
function day(date: string, hours: number | null, patch: Partial<Day> = {}): Day {
  const start = new Date(`${date}T08:00:00`).getTime();
  const punches: Punch[] = emptyPunches().map((p) =>
    p.position === 0 ? { ...p, at: start } : p.position === 3 && hours != null ? { ...p, at: start + hours * H } : p,
  );
  return { date, punches, priorities: [], overtimeApproved: false, retroNote: '', retroAt: null, workMinutes: null, sessions: [], ...patch };
}

describe('weekHours', () => {
  it('adds up Monday to the day, today live, against the weekly target', () => {
    const days = [day('2026-09-28', 8), day('2026-09-29', 7.5), day(TODAY, null)];
    expect(weekHours(days, settings, TODAY, TODAY, NOW)).toEqual({ workedSeconds: (8 + 7.5 + 4) * 3600, targetSeconds: 40 * 3600, met: false });
  });

  it("leaves out days before the week's Monday and after the day", () => {
    const days = [day('2026-09-27', 5), day('2026-09-28', 8), day('2026-09-29', 8)];
    expect(weekHours(days, settings, '2026-09-28', TODAY, NOW).workedSeconds).toBe(8 * 3600);
  });

  it('stops a past day left clocked in at the end of that day, as its sheet does', () => {
    const open = day('2026-09-28', null);
    expect(weekHours([open], settings, '2026-09-29', TODAY, NOW).workedSeconds).toBe(16 * 3600 - 1);
  });

  it('reports a target of nothing when the week line is off', () => {
    expect(weekHours([], { ...settings, weekMinutes: 0 }, TODAY, TODAY, NOW)).toEqual({ workedSeconds: 0, targetSeconds: 0, met: false });
  });

  it('is met once the worked time reaches the target, not before', () => {
    const days = [day('2026-09-28', 8), day('2026-09-29', 8)];
    expect(weekHours(days, { ...settings, weekMinutes: 16 * 60 }, TODAY, TODAY, NOW).met).toBe(true);
    expect(weekHours(days, { ...settings, weekMinutes: 16 * 60 + 1 }, TODAY, TODAY, NOW).met).toBe(false);
  });
});
