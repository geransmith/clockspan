import { describe, expect, it } from 'vitest';
import { clampToDay, clockOutPosition, computeTimeclock, emptyPunches, extraPairs, normalizePunches, secondMealApplies, timeclockForDate } from './timeclock';
import type { Punch } from '../types';

const settings = { workMinutes: 480, lunchDeadlineMinutes: 300, lunchMinutes: 30, secondMealAfterMinutes: 600 };
const H = 3_600_000;
const M = 60_000;
const T0 = new Date(2026, 8, 16, 8, 0).getTime(); // 8:00 local

function punches(times: (number | null)[]): Punch[] {
  return times.map((at, position) => ({ position, kind: position % 2 === 0 ? 'in' : 'out', at }));
}

describe('computeTimeclock', () => {
  it('is empty before clock-in', () => {
    const r = computeTimeclock(emptyPunches(), settings, T0);
    expect(r.state).toBe('not-started');
    expect(r.lunchBy).toBeNull();
    expect(r.clockOutAt).toBeNull();
    expect(r.remainingSeconds).toBe(480 * 60);
  });

  it('projects lunch-by and clock-out from clock-in alone', () => {
    const r = computeTimeclock(punches([T0, null, null]), settings, T0 + 2 * H);
    expect(r.state).toBe('working');
    expect(r.lunchBy).toBe(T0 + 5 * H);
    expect(r.lunchStatus).toBe('upcoming');
    expect(r.workedSeconds).toBe(2 * 3600);
    expect(r.clockOutAt).toBe(T0 + 8.5 * H); // 8h work + 30m assumed lunch
    expect(r.clockOutStatus).toBe('upcoming');
  });

  it('never goes negative for a future clock-in', () => {
    const r = computeTimeclock(punches([T0 + H, null, null]), settings, T0);
    expect(r.workedSeconds).toBe(0);
    expect(r.clockOutAt).toBe(T0 + H + 8.5 * H);
  });

  it('flags lunch overdue after the deadline', () => {
    const r = computeTimeclock(punches([T0, null, null]), settings, T0 + 5 * H + 10 * M);
    expect(r.lunchStatus).toBe('overdue');
  });

  it('tracks a lunch in progress and keeps the 30m assumption until it runs long', () => {
    const p = punches([T0, T0 + 4 * H, null]);
    const early = computeTimeclock(p, settings, T0 + 4 * H + 10 * M);
    expect(early.state).toBe('at-lunch');
    expect(early.lunchStatus).toBe('taken');
    expect(early.workedSeconds).toBe(4 * 3600);
    expect(early.offClockSeconds).toBe(10 * 60);
    expect(early.clockOutAt).toBe(T0 + 8.5 * H);

    const long = computeTimeclock(p, settings, T0 + 4 * H + 45 * M);
    expect(long.clockOutAt).toBe(T0 + 8 * H + 45 * M); // lunch ran 15m long
  });

  it('accounts for the actual lunch length after returning', () => {
    const p = punches([T0, T0 + 4 * H, T0 + 4 * H + 45 * M]);
    const r = computeTimeclock(p, settings, T0 + 5 * H);
    expect(r.state).toBe('working');
    expect(r.workedSeconds).toBe(4 * 3600 + 15 * 60);
    expect(r.offClockSeconds).toBe(45 * 60);
    expect(r.clockOutAt).toBe(T0 + 8 * H + 45 * M);
  });

  it('supports an extra break before lunch (chronological, not positional)', () => {
    // 8:00 in, 9:30 out (appointment), 10:30 in, lunch not yet taken.
    const p = punches([T0, null, null, T0 + 1.5 * H, T0 + 2.5 * H]);
    const r = computeTimeclock(p, settings, T0 + 3 * H);
    expect(r.error).toBeNull();
    expect(r.state).toBe('working');
    expect(r.workedSeconds).toBe(2 * 3600);
    expect(r.offClockSeconds).toBe(3600);
    expect(r.lunchStatus).toBe('upcoming');
    expect(r.clockOutAt).toBe(T0 + 9.5 * H); // 8h + 1h break + 30m lunch
  });

  it('pushes clock-out later while on a non-lunch break', () => {
    const p = punches([T0, T0 + 4 * H, T0 + 4.5 * H, T0 + 6 * H, null]);
    const r = computeTimeclock(p, settings, T0 + 6 * H + 20 * M);
    expect(r.state).toBe('on-break');
    expect(r.workedSeconds).toBe(5.5 * 3600);
    expect(r.clockOutAt).toBe(T0 + 6 * H + 20 * M + 2.5 * H);
  });

  it('reports over time once the target is passed while clocked in', () => {
    const p = punches([T0, T0 + 4 * H, T0 + 4.5 * H]);
    const r = computeTimeclock(p, settings, T0 + 9 * H);
    expect(r.remainingSeconds).toBe(0);
    expect(r.overSeconds).toBe(30 * 60);
    expect(r.clockOutStatus).toBe('over');
    expect(r.clockOutAt).toBe(T0 + 8.5 * H); // anchored to the moment the target was hit
  });

  it('is done after a final clock-out with the target met', () => {
    const p = punches([T0, T0 + 4 * H, T0 + 4.5 * H, T0 + 8.5 * H, null]);
    const r = computeTimeclock(p, settings, T0 + 12 * H);
    expect(r.state).toBe('done');
    expect(r.clockOutStatus).toBe('done');
    expect(r.clockOutAt).toBe(T0 + 8.5 * H);
    expect(r.offClockSeconds).toBe(30 * 60); // open time after the final out is not counted
  });

  it('flags out-of-order punches instead of producing garbage', () => {
    const p = punches([T0, T0 + 2 * H, T0 + 1 * H]);
    const r = computeTimeclock(p, settings, T0 + 3 * H);
    expect(r.error).not.toBeNull();
  });

  it('ends the day at an explicit Clock out even when short of the target', () => {
    // Clock in, no lunch, Clock out (position 3) at 15:00 on an 8h day.
    const p = punches([T0, null, null, T0 + 7 * H]);
    const r = computeTimeclock(p, settings, T0 + 7 * H + 5 * M);
    expect(r.state).toBe('done');
    expect(r.clockOutStatus).toBe('done');
    expect(r.clockOutAt).toBe(T0 + 7 * H);
    expect(r.remainingSeconds).toBe(3600);
    expect(r.secondMealBy).toBeNull();
  });

  it('is on a break, not done, when a later pair is open after an early clock-out', () => {
    // 15:00 out (was the clock out), came back: Out 1 = 15:00, In 1 unset, Clock out unset.
    const p = punches([T0, T0 + 4 * H, T0 + 4.5 * H, T0 + 7 * H, null, null]);
    const r = computeTimeclock(p, settings, T0 + 7 * H + 30 * M);
    expect(r.state).toBe('on-break');
  });

  it('anchors the clock-out target to the latest clock-in after a break', () => {
    // 8:00 in, lunch 12:00–12:30, out 14:00, back 15:00: 5.5h worked, 2.5h to go from 15:00.
    const p = punches([T0, T0 + 4 * H, T0 + 4.5 * H, T0 + 6 * H, T0 + 7 * H, null]);
    const r = computeTimeclock(p, settings, T0 + 7 * H + 10 * M);
    expect(r.state).toBe('working');
    expect(r.clockOutAt).toBe(T0 + 9.5 * H);
    // Same instant a minute later: the target doesn't drift while working.
    expect(computeTimeclock(p, settings, T0 + 7 * H + 11 * M).clockOutAt).toBe(T0 + 9.5 * H);
  });

  it('re-anchors at the re-clock-in once the target was already met', () => {
    // Worked 8h (8:00–12:00, 12:30–16:30), clocked out, came back at 19:00.
    const p = punches([T0, T0 + 4 * H, T0 + 4.5 * H, T0 + 8.5 * H, T0 + 11 * H, null]);
    const r = computeTimeclock(p, settings, T0 + 11 * H + 20 * M);
    expect(r.clockOutStatus).toBe('over');
    expect(r.clockOutAt).toBe(T0 + 11 * H);
  });
});

describe('second meal period', () => {
  it('projects the instant the 10th hour of work ends and holds it while working', () => {
    const p = punches([T0, T0 + 4 * H, T0 + 4.5 * H, null]);
    const r = computeTimeclock(p, settings, T0 + 6 * H);
    expect(r.secondMealBy).toBe(T0 + 10.5 * H);
    expect(r.secondMealStatus).toBe('upcoming');
    expect(computeTimeclock(p, settings, T0 + 9 * H).secondMealBy).toBe(T0 + 10.5 * H);
  });

  it('drifts later during a break and is overdue once passed', () => {
    const p = punches([T0, T0 + 4 * H, null, null]);
    expect(computeTimeclock(p, settings, T0 + 4 * H + 10 * M).secondMealBy).toBe(T0 + 10 * H + 10 * M);
    const over = computeTimeclock(punches([T0, T0 + 4 * H, T0 + 4.5 * H, null]), settings, T0 + 11 * H);
    expect(over.secondMealStatus).toBe('overdue');
    expect(over.secondMealBy).toBe(T0 + 10.5 * H);
  });

  it('counts any break after lunch as taken, but not one before it', () => {
    const afterLunch = punches([T0, T0 + 4 * H, T0 + 4.5 * H, T0 + 8 * H, T0 + 8.5 * H, null]);
    expect(computeTimeclock(afterLunch, settings, T0 + 9 * H).secondMealStatus).toBe('taken');
    const beforeLunch = punches([T0, T0 + 4 * H, T0 + 4.5 * H, T0 + 1.5 * H, T0 + 2 * H, null]);
    expect(computeTimeclock(beforeLunch, settings, T0 + 9 * H).secondMealStatus).toBe('upcoming');
  });

  it('only applies when a long day is actually in play', () => {
    const p = punches([T0, T0 + 4 * H, T0 + 4.5 * H, null]);
    const normal = computeTimeclock(p, settings, T0 + 6 * H);
    expect(secondMealApplies(normal, settings, false)).toBe(false);
    expect(secondMealApplies(normal, settings, true)).toBe(true);
    expect(secondMealApplies(normal, { ...settings, workMinutes: 600 }, false)).toBe(true);
    const over = computeTimeclock(p, settings, T0 + 9 * H);
    expect(secondMealApplies(over, settings, false)).toBe(true);
    const taken = computeTimeclock(punches([T0, T0 + 4 * H, T0 + 4.5 * H, T0 + 8 * H, T0 + 8.5 * H, null]), settings, T0 + 9 * H);
    expect(secondMealApplies(taken, settings, true)).toBe(false);
    const atLunch = computeTimeclock(punches([T0, T0 + 4 * H, null, null]), settings, T0 + 4 * H + 5 * M);
    expect(secondMealApplies(atLunch, settings, true)).toBe(false);
  });
});

describe('punch rows', () => {
  it('starts with four rows ending in the clock out', () => {
    expect(emptyPunches().map((p) => p.kind)).toEqual(['in', 'out', 'in', 'out']);
    expect(clockOutPosition(emptyPunches())).toBe(3);
    expect(clockOutPosition(punches([T0, null, null]))).toBeNull();
  });

  it('normalizes to a contiguous list whose last row is an out', () => {
    expect(normalizePunches([]).map((p) => p.position)).toEqual([0, 1, 2, 3]);
    // A complete extra pair gets a fresh clock out after it.
    const withPair = normalizePunches(punches([T0, null, null, T0 + H, T0 + 2 * H]));
    expect(withPair.map((p) => p.at)).toEqual([T0, null, null, T0 + H, T0 + 2 * H, null]);
    expect(clockOutPosition(withPair)).toBe(5);
  });

  it('turns an old-style final out (pair with unset in) into the clock out', () => {
    const old = normalizePunches(punches([T0, T0 + 4 * H, T0 + 4.5 * H, T0 + 8.5 * H, null]));
    expect(old.map((p) => p.at)).toEqual([T0, T0 + 4 * H, T0 + 4.5 * H, T0 + 8.5 * H]);
    expect(clockOutPosition(old)).toBe(3);
  });

  it('places extra pairs before lunch until lunch is punched or time says otherwise', () => {
    const unsetLunch = normalizePunches(punches([T0, null, null, null, null, null]));
    expect(extraPairs(unsetLunch).map((p) => p.beforeLunch)).toEqual([true]);
    const lunchSet = normalizePunches(punches([T0, T0 + 4 * H, T0 + 4.5 * H, null, null, null]));
    expect(extraPairs(lunchSet).map((p) => p.beforeLunch)).toEqual([false]);
    const early = normalizePunches(punches([T0, T0 + 4 * H, T0 + 4.5 * H, T0 + H, T0 + 2 * H, null]));
    expect(extraPairs(early).map((p) => p.beforeLunch)).toEqual([true]);
    const late = normalizePunches(punches([T0, T0 + 4 * H, T0 + 4.5 * H, T0 + 6 * H, T0 + 7 * H, null]));
    expect(extraPairs(late).map((p) => [p.out.position, p.in.position, p.beforeLunch])).toEqual([[3, 4, false]]);
    expect(extraPairs(emptyPunches())).toEqual([]);
  });
});

describe('frozen (past day)', () => {
  it('treats a final clock-out as done even when short of the target', () => {
    const p = punches([T0, T0 + 4 * H, T0 + 4.5 * H, T0 + 7 * H, null]);
    const r = computeTimeclock(p, settings, T0 + 16 * H, { frozen: true });
    expect(r.state).toBe('done');
    expect(r.clockOutAt).toBe(T0 + 7 * H);
    expect(r.workedSeconds).toBe(6.5 * 3600);
  });

  it('still counts an unclosed clock-in up to the frozen instant', () => {
    const r = computeTimeclock(punches([T0, null, null]), settings, T0 + 16 * H, { frozen: true });
    expect(r.state).toBe('working');
    expect(r.workedSeconds).toBe(16 * 3600);
  });
});

describe('timeclockForDate', () => {
  const today = '2026-09-17';
  const yesterday = '2026-09-16';
  const nowToday = new Date(2026, 8, 17, 10, 0).getTime();

  it('runs today live', () => {
    expect(clampToDay(today, today, nowToday)).toBe(nowToday);
    const r = timeclockForDate(punches([T0 + 24 * H, null, null]), settings, today, today, nowToday);
    expect(r.state).toBe('working');
    expect(r.workedSeconds).toBe(2 * 3600);
  });

  it('stops a past day with an unclosed clock-in at the end of that day', () => {
    expect(clampToDay(yesterday, today, nowToday)).toBe(new Date(2026, 8, 17, 0, 0).getTime() - 1);
    const r = timeclockForDate(punches([T0, null, null]), settings, yesterday, today, nowToday);
    expect(r.state).toBe('working');
    expect(r.workedSeconds).toBe(16 * 3600 - 1);
  });

  it('marks a past day done once it is off the clock, target or not', () => {
    const r = timeclockForDate(punches([T0, null, null, T0 + 3 * H]), settings, yesterday, today, nowToday);
    expect(r.state).toBe('done');
    expect(r.clockOutAt).toBe(T0 + 3 * H);
  });
});
