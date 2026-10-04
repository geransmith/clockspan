import { describe, expect, it } from 'vitest';
import { HOUR_MS, MINUTE_MS } from '../../../shared/dates.js';
import { TEST_SETTINGS } from '../test/fixtures';
import {
  addPunchPair,
  clampToDay,
  clockOutPosition,
  computeTimeclock,
  daySettings,
  dayTimeclock,
  emptyPunches,
  extraPairs,
  lunchInPunchOrder,
  lunchRowsShown,
  nextPunchPosition,
  normalizePunches,
  overtimeOn,
  removePunchPair,
  secondMealApplies,
  targetFraction,
  timeclockForDate,
  type TimeclockSettings,
} from './timeclock';
import type { Punch } from '../types';

const settings = TEST_SETTINGS;
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
    const r = computeTimeclock(punches([T0, null, null]), settings, T0 + 2 * HOUR_MS);
    expect(r.state).toBe('working');
    expect(r.lunchBy).toBe(T0 + 5 * HOUR_MS);
    expect(r.lunchStatus).toBe('upcoming');
    expect(r.workedSeconds).toBe(2 * 3600);
    expect(r.clockOutAt).toBe(T0 + 8.5 * HOUR_MS); // 8h work + 30m assumed lunch
    expect(r.clockOutStatus).toBe('upcoming');
  });

  it('never goes negative for a future clock-in', () => {
    const r = computeTimeclock(punches([T0 + HOUR_MS, null, null]), settings, T0);
    expect(r.workedSeconds).toBe(0);
    expect(r.clockOutAt).toBe(T0 + HOUR_MS + 8.5 * HOUR_MS);
  });

  it('flags lunch overdue after the deadline', () => {
    const r = computeTimeclock(punches([T0, null, null]), settings, T0 + 5 * HOUR_MS + 10 * MINUTE_MS);
    expect(r.lunchStatus).toBe('overdue');
  });

  it('tracks a lunch in progress and keeps the 30m assumption until it runs long', () => {
    const p = punches([T0, T0 + 4 * HOUR_MS, null]);
    const early = computeTimeclock(p, settings, T0 + 4 * HOUR_MS + 10 * MINUTE_MS);
    expect(early.state).toBe('at-lunch');
    expect(early.lunchStatus).toBe('taken');
    expect(early.workedSeconds).toBe(4 * 3600);
    expect(early.clockOutAt).toBe(T0 + 8.5 * HOUR_MS);

    const long = computeTimeclock(p, settings, T0 + 4 * HOUR_MS + 45 * MINUTE_MS);
    expect(long.clockOutAt).toBe(T0 + 8 * HOUR_MS + 45 * MINUTE_MS); // lunch ran 15m long
  });

  it('accounts for the actual lunch length after returning', () => {
    const p = punches([T0, T0 + 4 * HOUR_MS, T0 + 4 * HOUR_MS + 45 * MINUTE_MS]);
    const r = computeTimeclock(p, settings, T0 + 5 * HOUR_MS);
    expect(r.state).toBe('working');
    expect(r.workedSeconds).toBe(4 * 3600 + 15 * 60);
    expect(r.clockOutAt).toBe(T0 + 8 * HOUR_MS + 45 * MINUTE_MS);
  });

  it('supports an extra break before lunch (chronological, not positional)', () => {
    // 8:00 in, 9:30 out (appointment), 10:30 in, lunch not yet taken.
    const p = punches([T0, null, null, T0 + 1.5 * HOUR_MS, T0 + 2.5 * HOUR_MS]);
    const r = computeTimeclock(p, settings, T0 + 3 * HOUR_MS);
    expect(r.outOfOrder).toBe(false);
    expect(r.state).toBe('working');
    expect(r.workedSeconds).toBe(2 * 3600);
    expect(r.lunchStatus).toBe('upcoming');
    expect(r.clockOutAt).toBe(T0 + 9.5 * HOUR_MS); // 8h + 1h break + 30m lunch
  });

  it('pushes clock-out later while on a non-lunch break', () => {
    const p = punches([T0, T0 + 4 * HOUR_MS, T0 + 4.5 * HOUR_MS, T0 + 6 * HOUR_MS, null]);
    const r = computeTimeclock(p, settings, T0 + 6 * HOUR_MS + 20 * MINUTE_MS);
    expect(r.state).toBe('on-break');
    expect(r.workedSeconds).toBe(5.5 * 3600);
    expect(r.clockOutAt).toBe(T0 + 6 * HOUR_MS + 20 * MINUTE_MS + 2.5 * HOUR_MS);
  });

  it('reports over time once the target is passed while clocked in', () => {
    const p = punches([T0, T0 + 4 * HOUR_MS, T0 + 4.5 * HOUR_MS]);
    const r = computeTimeclock(p, settings, T0 + 9 * HOUR_MS);
    expect(r.remainingSeconds).toBe(0);
    expect(r.overSeconds).toBe(30 * 60);
    expect(r.clockOutStatus).toBe('over');
    expect(r.clockOutAt).toBe(T0 + 8.5 * HOUR_MS); // anchored to the moment the target was hit
  });

  it('keeps the targets on one instant across ticks, whatever the sub-second phase of now', () => {
    // A clock-in with seconds on it (the API takes any instant) and ticks whose milliseconds
    // drift, as setInterval's do. The alarm keys round the target to the minute, so a target
    // that wandered by up to a second would flip keys around :30 and fire twice.
    const clockIn = T0 + 29_600;
    const p = punches([clockIn, null, null, null]);
    const before = new Set<number>();
    const meal = new Set<number>();
    const over = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const jitter = (i * 137) % 1000;
      before.add(computeTimeclock(p, settings, clockIn + 4 * HOUR_MS + i * 1000 + jitter).clockOutAt!);
      meal.add(computeTimeclock(p, settings, clockIn + 4 * HOUR_MS + i * 1000 + jitter).secondMealBy!);
      over.add(computeTimeclock(p, settings, clockIn + 9 * HOUR_MS + i * 1000 + jitter).clockOutAt!);
    }
    expect([...before]).toEqual([clockIn + 8.5 * HOUR_MS]); // 8h work + 30m assumed lunch
    expect([...meal]).toEqual([clockIn + 10 * HOUR_MS]);
    expect([...over]).toEqual([clockIn + 8 * HOUR_MS]); // the moment the target was hit, no lunch taken
  });

  it('is done after a final clock-out with the target met', () => {
    const p = punches([T0, T0 + 4 * HOUR_MS, T0 + 4.5 * HOUR_MS, T0 + 8.5 * HOUR_MS]);
    const r = computeTimeclock(p, settings, T0 + 12 * HOUR_MS);
    expect(r.state).toBe('done');
    expect(r.clockOutStatus).toBe('done');
    expect(r.clockOutAt).toBe(T0 + 8.5 * HOUR_MS);
    expect(r.workedSeconds).toBe(8 * 3600);
  });

  it("stays on a break when an extra pair's Out is punched past the target", () => {
    // Out 1 at 17:00 after 8 h 30 m worked, a second meal on an overtime day: the day goes on.
    const p = punches([T0, T0 + 4 * HOUR_MS, T0 + 4.5 * HOUR_MS, T0 + 9 * HOUR_MS, null, null]);
    for (const now of [T0 + 9 * HOUR_MS + 10 * MINUTE_MS, T0 + 9 * HOUR_MS + 25 * MINUTE_MS]) {
      const r = computeTimeclock(p, settings, now);
      expect(r.state).toBe('on-break');
      expect(r.clockOutStatus).toBe('over');
      expect(r.clockOutAt).toBe(T0 + 8.5 * HOUR_MS); // the target's instant, holding still on the break
      expect(r.secondMealStatus).toBe('taken');
    }
    expect(nextPunchPosition(p, true)).toBe(4);
  });

  it('is on a break after "Add extra out / in" on a day that met its target', () => {
    const p = addPunchPair(punches([T0, T0 + 4 * HOUR_MS, T0 + 4.5 * HOUR_MS, T0 + 8.5 * HOUR_MS]));
    expect(computeTimeclock(p, settings, T0 + 8.5 * HOUR_MS + 5 * MINUTE_MS).state).toBe('on-break');
  });

  it('flags out-of-order punches instead of producing garbage', () => {
    const p = punches([T0, T0 + 2 * HOUR_MS, T0 + 1 * HOUR_MS]);
    const r = computeTimeclock(p, settings, T0 + 3 * HOUR_MS);
    expect(r.outOfOrder).toBe(true);
  });

  it('orders two punches at the same minute by row, whatever order the rows arrive in', () => {
    // Lunch out and back in at the same instant: a zero-length lunch, not out of order.
    const r = computeTimeclock(punches([T0, T0 + 4 * HOUR_MS, T0 + 4 * HOUR_MS, null]).reverse(), settings, T0 + 5 * HOUR_MS);
    expect(r.outOfOrder).toBe(false);
    expect(r.state).toBe('working');
    expect(r.workedSeconds).toBe(5 * 3600);
  });

  it('ends the day at an explicit Clock out even when short of the target', () => {
    // Clock in, no lunch, Clock out (position 3) at 15:00 on an 8h day.
    const p = punches([T0, null, null, T0 + 7 * HOUR_MS]);
    const r = computeTimeclock(p, settings, T0 + 7 * HOUR_MS + 5 * MINUTE_MS);
    expect(r.state).toBe('done');
    expect(r.clockOutStatus).toBe('done');
    expect(r.clockOutAt).toBe(T0 + 7 * HOUR_MS);
    expect(r.remainingSeconds).toBe(3600);
    expect(r.secondMealBy).toBeNull();
  });

  it('is on a break, not done, when a later pair is open after an early clock-out', () => {
    // 15:00 out (was the clock out), came back: Out 1 = 15:00, In 1 unset, Clock out unset.
    const p = punches([T0, T0 + 4 * HOUR_MS, T0 + 4.5 * HOUR_MS, T0 + 7 * HOUR_MS, null, null]);
    const r = computeTimeclock(p, settings, T0 + 7 * HOUR_MS + 30 * MINUTE_MS);
    expect(r.state).toBe('on-break');
  });

  it('anchors the clock-out target to the latest clock-in after a break', () => {
    // 8:00 in, lunch 12:00–12:30, out 14:00, back 15:00: 5.5h worked, 2.5h to go from 15:00.
    const p = punches([T0, T0 + 4 * HOUR_MS, T0 + 4.5 * HOUR_MS, T0 + 6 * HOUR_MS, T0 + 7 * HOUR_MS, null]);
    const r = computeTimeclock(p, settings, T0 + 7 * HOUR_MS + 10 * MINUTE_MS);
    expect(r.state).toBe('working');
    expect(r.clockOutAt).toBe(T0 + 9.5 * HOUR_MS);
    // Same instant a minute later: the target doesn't drift while working.
    expect(computeTimeclock(p, settings, T0 + 7 * HOUR_MS + 11 * MINUTE_MS).clockOutAt).toBe(T0 + 9.5 * HOUR_MS);
  });

  it('is the target instant plus the time off since, once the target was already met', () => {
    // Worked 8h (8:00–12:00, 12:30–16:30), clocked out, came back at 19:00.
    const p = punches([T0, T0 + 4 * HOUR_MS, T0 + 4.5 * HOUR_MS, T0 + 8.5 * HOUR_MS, T0 + 11 * HOUR_MS, null]);
    const r = computeTimeclock(p, settings, T0 + 11 * HOUR_MS + 20 * MINUTE_MS);
    expect(r.clockOutStatus).toBe('over');
    expect(r.clockOutAt).toBe(T0 + 11 * HOUR_MS);
  });
});

describe('times typed ahead of now', () => {
  it('counts a Lunch out once the clock reaches it', () => {
    const p = punches([T0, T0 + 4 * HOUR_MS, null, null]);
    const before = computeTimeclock(p, settings, T0 + 2 * HOUR_MS);
    expect(before.state).toBe('working');
    expect(before.workedSeconds).toBe(2 * 3600);
    expect(before.lunchOut).toBeNull();
    expect(before.lunchStatus).toBe('upcoming');
    expect(before.clockOutAt).toBe(T0 + 8.5 * HOUR_MS);
    const reached = computeTimeclock(p, settings, T0 + 4 * HOUR_MS + 10 * MINUTE_MS);
    expect(reached.state).toBe('at-lunch');
    expect(reached.lunchStatus).toBe('taken');
  });

  it('keeps a Lunch in planned at the Lunch out from ending the lunch', () => {
    const r = computeTimeclock(punches([T0, T0 + 4 * HOUR_MS, T0 + 4.5 * HOUR_MS, null]), settings, T0 + 4 * HOUR_MS + 10 * MINUTE_MS);
    expect(r.state).toBe('at-lunch');
    expect(r.workedSeconds).toBe(4 * 3600);
    expect(r.clockOutAt).toBe(T0 + 8.5 * HOUR_MS);
  });

  it('ends the day at a Clock out typed ahead once it is reached', () => {
    const p = punches([T0, null, null, T0 + 9 * HOUR_MS]);
    const early = computeTimeclock(p, settings, T0 + HOUR_MS);
    expect(early.state).toBe('working');
    expect(early.clockOutStatus).toBe('upcoming');
    expect(early.secondMealBy).not.toBeNull();
    const reached = computeTimeclock(p, settings, T0 + 9 * HOUR_MS);
    expect(reached.state).toBe('done');
    expect(reached.clockOutAt).toBe(T0 + 9 * HOUR_MS);
  });

  it('flags a time out of order at once, while it is still ahead', () => {
    // Lunch in with no Lunch out: two ins in a row, the second one still to come.
    expect(computeTimeclock(punches([T0, null, T0 + 4.5 * HOUR_MS, null]), settings, T0 + HOUR_MS).outOfOrder).toBe(true);
  });
});

describe('daySettings', () => {
  it("puts a day's own work-day length in place of the usual one, and nothing else", () => {
    expect(daySettings(settings, { workMinutes: 240 })).toEqual({ ...settings, workMinutes: 240 });
    expect(daySettings(settings, { workMinutes: null })).toBe(settings);
    expect(daySettings(settings, undefined)).toBe(settings);
  });
});

describe('with the meal-period rules off', () => {
  const noMeals = { ...settings, mealRules: false };

  it('plans no lunch and has no lunch deadline to meet, on a day of any length', () => {
    const r = computeTimeclock(punches([T0, null, null, null]), noMeals, T0 + 6 * HOUR_MS);
    expect(r.lunchStatus).toBe('not-needed');
    expect(r.clockOutAt).toBe(T0 + 8 * HOUR_MS); // 8h worked, no lunch added
  });

  it('still counts a lunch that was punched', () => {
    const r = computeTimeclock(punches([T0, T0 + 4 * HOUR_MS, T0 + 4.5 * HOUR_MS, null]), noMeals, T0 + 6 * HOUR_MS);
    expect(r.lunchStatus).toBe('taken');
    expect(r.workedSeconds).toBe(5.5 * 3600);
  });

  it('never brings in the second meal period', () => {
    const long = computeTimeclock(punches([T0, T0 + 4 * HOUR_MS, T0 + 4.5 * HOUR_MS, null]), noMeals, T0 + 10 * HOUR_MS);
    expect(secondMealApplies(long, noMeals, true)).toBe(false);
    expect(secondMealApplies(long, settings, true)).toBe(true);
  });
});

describe('a day that needs no lunch', () => {
  const short = (workMinutes: number) => ({ ...settings, workMinutes });

  it('plans no lunch when the whole day fits in the lunch window', () => {
    const r = computeTimeclock(punches([T0, null, null, null]), short(240), T0 + HOUR_MS);
    expect(r.lunchStatus).toBe('not-needed');
    expect(r.clockOutAt).toBe(T0 + 4 * HOUR_MS); // not 4h 30m
    expect(r.lunchBy).toBe(T0 + 5 * HOUR_MS);
  });

  it('counts a day exactly as long as the window as fitting, even past the deadline on the wall clock', () => {
    // 5 h of work with a 20 min break: the clock runs past 13:00, the work does not pass 5 h.
    const p = punches([T0, null, null, T0 + HOUR_MS, T0 + HOUR_MS + 20 * MINUTE_MS, null]);
    const r = computeTimeclock(p, short(300), T0 + 2 * HOUR_MS);
    expect(r.lunchStatus).toBe('not-needed');
    expect(r.clockOutAt).toBe(T0 + 5 * HOUR_MS + 20 * MINUTE_MS);
  });

  it('owes a lunch once the work runs past the window', () => {
    const r = computeTimeclock(punches([T0, null, null, null]), short(300), T0 + 5 * HOUR_MS + 10 * MINUTE_MS);
    expect(r.clockOutStatus).toBe('over');
    expect(r.lunchStatus).toBe('overdue');
  });

  it('judges a finished day by what was worked', () => {
    // An 8 h day that ended after 4 h of work needed no lunch; one that ended after 7 h did.
    expect(computeTimeclock(punches([T0, null, null, T0 + 4 * HOUR_MS]), settings, T0 + 5 * HOUR_MS).lunchStatus).toBe('not-needed');
    expect(computeTimeclock(punches([T0, null, null, T0 + 7 * HOUR_MS]), settings, T0 + 8 * HOUR_MS).lunchStatus).toBe('overdue');
  });

  it('leaves a normal day and a lunch already taken alone', () => {
    expect(computeTimeclock(punches([T0, null, null, null]), settings, T0 + HOUR_MS).lunchStatus).toBe('upcoming');
    expect(computeTimeclock(punches([T0, T0 + 2 * HOUR_MS, T0 + 2.5 * HOUR_MS, null]), short(240), T0 + 3 * HOUR_MS).lunchStatus).toBe('taken');
  });
});

describe('second meal period', () => {
  it('projects the instant the 10th hour of work ends and holds it while working', () => {
    const p = punches([T0, T0 + 4 * HOUR_MS, T0 + 4.5 * HOUR_MS, null]);
    const r = computeTimeclock(p, settings, T0 + 6 * HOUR_MS);
    expect(r.secondMealBy).toBe(T0 + 10.5 * HOUR_MS);
    expect(r.secondMealStatus).toBe('upcoming');
    expect(computeTimeclock(p, settings, T0 + 9 * HOUR_MS).secondMealBy).toBe(T0 + 10.5 * HOUR_MS);
  });

  it('drifts later during a break and is overdue once passed', () => {
    const p = punches([T0, T0 + 4 * HOUR_MS, null, null]);
    expect(computeTimeclock(p, settings, T0 + 4 * HOUR_MS + 10 * MINUTE_MS).secondMealBy).toBe(T0 + 10 * HOUR_MS + 10 * MINUTE_MS);
    const over = computeTimeclock(punches([T0, T0 + 4 * HOUR_MS, T0 + 4.5 * HOUR_MS, null]), settings, T0 + 11 * HOUR_MS);
    expect(over.secondMealStatus).toBe('overdue');
    expect(over.secondMealBy).toBe(T0 + 10.5 * HOUR_MS);
  });

  it('counts any break after lunch as taken, but not one before it', () => {
    const afterLunch = punches([T0, T0 + 4 * HOUR_MS, T0 + 4.5 * HOUR_MS, T0 + 8 * HOUR_MS, T0 + 8.5 * HOUR_MS, null]);
    expect(computeTimeclock(afterLunch, settings, T0 + 9 * HOUR_MS).secondMealStatus).toBe('taken');
    const beforeLunch = punches([T0, T0 + 4 * HOUR_MS, T0 + 4.5 * HOUR_MS, T0 + 1.5 * HOUR_MS, T0 + 2 * HOUR_MS, null]);
    expect(computeTimeclock(beforeLunch, settings, T0 + 9 * HOUR_MS).secondMealStatus).toBe('upcoming');
  });

  it('only applies when a long day is actually in play', () => {
    const p = punches([T0, T0 + 4 * HOUR_MS, T0 + 4.5 * HOUR_MS, null]);
    const normal = computeTimeclock(p, settings, T0 + 6 * HOUR_MS);
    expect(secondMealApplies(normal, settings, false)).toBe(false);
    expect(secondMealApplies(normal, settings, true)).toBe(true);
    // A 10 h day (a 4×10 schedule) ends as the 10th hour does: no second meal is owed.
    expect(secondMealApplies(normal, { ...settings, workMinutes: 600 }, false)).toBe(false);
    expect(secondMealApplies(normal, { ...settings, workMinutes: 601 }, false)).toBe(true);
    const over = computeTimeclock(p, settings, T0 + 9 * HOUR_MS);
    expect(secondMealApplies(over, settings, false)).toBe(true);
    const taken = computeTimeclock(punches([T0, T0 + 4 * HOUR_MS, T0 + 4.5 * HOUR_MS, T0 + 8 * HOUR_MS, T0 + 8.5 * HOUR_MS, null]), settings, T0 + 9 * HOUR_MS);
    expect(secondMealApplies(taken, settings, true)).toBe(false);
    const atLunch = computeTimeclock(punches([T0, T0 + 4 * HOUR_MS, null, null]), settings, T0 + 4 * HOUR_MS + 5 * MINUTE_MS);
    expect(secondMealApplies(atLunch, settings, true)).toBe(false);
  });
});

describe('overtimeOn', () => {
  it("counts a day's approval only while the Overtime setting is on", () => {
    expect(overtimeOn({ overtimeApproval: false }, true)).toBe(false);
    expect(overtimeOn({ overtimeApproval: true }, true)).toBe(true);
    expect(overtimeOn({ overtimeApproval: true }, false)).toBe(false);
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
    const withPair = normalizePunches(punches([T0, null, null, T0 + HOUR_MS, T0 + 2 * HOUR_MS]));
    expect(withPair.map((p) => p.at)).toEqual([T0, null, null, T0 + HOUR_MS, T0 + 2 * HOUR_MS, null]);
    expect(clockOutPosition(withPair)).toBe(5);
  });

  it('turns an old-style final out (pair with unset in) into the clock out', () => {
    const old = normalizePunches(punches([T0, T0 + 4 * HOUR_MS, T0 + 4.5 * HOUR_MS, T0 + 8.5 * HOUR_MS, null]));
    expect(old.map((p) => p.at)).toEqual([T0, T0 + 4 * HOUR_MS, T0 + 4.5 * HOUR_MS, T0 + 8.5 * HOUR_MS]);
    expect(clockOutPosition(old)).toBe(3);
  });

  it('places extra pairs before lunch until lunch is punched or time says otherwise', () => {
    const unsetLunch = normalizePunches(punches([T0, null, null, null, null, null]));
    expect(extraPairs(unsetLunch).map((p) => p.beforeLunch)).toEqual([true]);
    const lunchSet = normalizePunches(punches([T0, T0 + 4 * HOUR_MS, T0 + 4.5 * HOUR_MS, null, null, null]));
    expect(extraPairs(lunchSet).map((p) => p.beforeLunch)).toEqual([false]);
    const early = normalizePunches(punches([T0, T0 + 4 * HOUR_MS, T0 + 4.5 * HOUR_MS, T0 + HOUR_MS, T0 + 2 * HOUR_MS, null]));
    expect(extraPairs(early).map((p) => p.beforeLunch)).toEqual([true]);
    const late = normalizePunches(punches([T0, T0 + 4 * HOUR_MS, T0 + 4.5 * HOUR_MS, T0 + 6 * HOUR_MS, T0 + 7 * HOUR_MS, null]));
    expect(extraPairs(late).map((p) => [p.out.position, p.in.position, p.beforeLunch])).toEqual([[3, 4, false]]);
    expect(extraPairs(emptyPunches())).toEqual([]);
  });

  it('lists no extra pairs for rows without a clock-out row, and stops at a gap', () => {
    // Un-normalized input (old data, tests): no odd last row means no pairs to place.
    expect(extraPairs(punches([T0, null, null]))).toEqual([]);
    // Positions 3-4 are a pair; 5 is missing, so 6 cannot pair with anything and 7 is the clock out.
    const gapped = punches([T0, null, null, null, null, null, null, null]).filter((p) => p.position !== 5);
    expect(extraPairs(gapped).map((p) => [p.out.position, p.in.position])).toEqual([[3, 4]]);
  });
});

describe('adding and removing an extra pair', () => {
  const day = [T0, T0 + 4 * HOUR_MS, T0 + 4.5 * HOUR_MS, T0 + 8.5 * HOUR_MS];

  it("turns the Clock out into the new pair's Out and adds an In and a fresh Clock out", () => {
    const next = addPunchPair(punches(day));
    expect(next.map((p) => [p.position, p.kind, p.at])).toEqual([
      [0, 'in', T0],
      [1, 'out', T0 + 4 * HOUR_MS],
      [2, 'in', T0 + 4.5 * HOUR_MS],
      [3, 'out', T0 + 8.5 * HOUR_MS],
      [4, 'in', null],
      [5, 'out', null],
    ]);
    expect(extraPairs(next).map((p) => p.out.at)).toEqual([T0 + 8.5 * HOUR_MS]);
    expect(clockOutPosition(next)).toBe(5);
  });

  it('removes a pair and renumbers the rows after it, handing nothing to the Clock out', () => {
    // Stepped out at 14:00 and not back: the Out's time goes with the pair, so the day isn't over.
    const next = removePunchPair(punches([T0, T0 + 4 * HOUR_MS, T0 + 4.5 * HOUR_MS, T0 + 6 * HOUR_MS, null, null]), 3);
    expect(next.map((p) => [p.position, p.kind, p.at])).toEqual([
      [0, 'in', T0],
      [1, 'out', T0 + 4 * HOUR_MS],
      [2, 'in', T0 + 4.5 * HOUR_MS],
      [3, 'out', null],
    ]);
  });
});

describe('frozen (past day)', () => {
  it('treats a final clock-out as done even when short of the target', () => {
    const p = punches([T0, T0 + 4 * HOUR_MS, T0 + 4.5 * HOUR_MS, T0 + 7 * HOUR_MS, null]);
    const r = computeTimeclock(p, settings, T0 + 16 * HOUR_MS, { frozen: true });
    expect(r.state).toBe('done');
    expect(r.clockOutAt).toBe(T0 + 7 * HOUR_MS);
    expect(r.workedSeconds).toBe(6.5 * 3600);
  });

  it('still counts an unclosed clock-in up to the frozen instant', () => {
    const r = computeTimeclock(punches([T0, null, null]), settings, T0 + 16 * HOUR_MS, { frozen: true });
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
    const r = timeclockForDate(punches([T0 + 24 * HOUR_MS, null, null]), settings, today, today, nowToday);
    expect(r.state).toBe('working');
    expect(r.workedSeconds).toBe(2 * 3600);
  });

  it('runs a stored day on its own work-day length (dayTimeclock)', () => {
    const p = punches([T0 + 24 * HOUR_MS, null, null, null]);
    expect(dayTimeclock({ date: today, punches: p, workMinutes: null }, settings, today, nowToday).clockOutAt).toBe(T0 + 32.5 * HOUR_MS);
    // A 4 h day needs no lunch, so none is added to its end.
    expect(dayTimeclock({ date: today, punches: p, workMinutes: 240 }, settings, today, nowToday).clockOutAt).toBe(T0 + 28 * HOUR_MS);
  });

  it('stops a past day with an unclosed clock-in at the end of that day', () => {
    expect(clampToDay(yesterday, today, nowToday)).toBe(new Date(2026, 8, 17, 0, 0).getTime() - 1);
    const r = timeclockForDate(punches([T0, null, null]), settings, yesterday, today, nowToday);
    expect(r.state).toBe('working');
    expect(r.workedSeconds).toBe(16 * 3600 - 1);
  });

  it('marks a past day done once it is off the clock, target or not', () => {
    // Out for lunch and never back: the same punches read as at lunch on a day still running.
    const p = punches([T0, T0 + 4 * HOUR_MS, null, null]);
    const r = timeclockForDate(p, settings, yesterday, today, nowToday);
    expect(r.state).toBe('done');
    expect(r.clockOutAt).toBe(T0 + 4 * HOUR_MS);
    expect(computeTimeclock(p, settings, T0 + 16 * HOUR_MS).state).toBe('at-lunch');
  });
});

describe('nextPunchPosition', () => {
  it('walks the fixed rows in order', () => {
    expect(nextPunchPosition(normalizePunches([]), true)).toBe(0);
    expect(nextPunchPosition(punches([T0, null, null, null]), true)).toBe(1);
    expect(nextPunchPosition(punches([T0, T0 + 4 * HOUR_MS, null, null]), true)).toBe(2);
    expect(nextPunchPosition(punches([T0, T0 + 4 * HOUR_MS, T0 + 4.5 * HOUR_MS, null]), true)).toBe(3);
    expect(nextPunchPosition(punches([T0, T0 + 4 * HOUR_MS, T0 + 4.5 * HOUR_MS, T0 + 8.5 * HOUR_MS]), true)).toBeNull();
  });

  it('puts a pair before lunch ahead of lunch, and one after lunch ahead of the clock out', () => {
    // Out 1 at 10:00, before a lunch not taken yet: its In is next, not Lunch out.
    expect(nextPunchPosition(punches([T0, null, null, T0 + 2 * HOUR_MS, null, null]), true)).toBe(4);
    // Lunch taken, then a pair added: its Out comes before the Clock out row.
    expect(nextPunchPosition(punches([T0, T0 + 4 * HOUR_MS, T0 + 4.5 * HOUR_MS, null, null, null]), true)).toBe(3);
    // Clocked out, then "Add extra out / in": the old clock out is Out 1, so In 1 is next.
    expect(nextPunchPosition(punches([T0, T0 + 4 * HOUR_MS, T0 + 4.5 * HOUR_MS, T0 + 6 * HOUR_MS, null, null]), true)).toBe(4);
  });

  it('skips rows that are missing', () => {
    expect(nextPunchPosition([], true)).toBeNull();
    expect(nextPunchPosition(punches([T0, null, null]), true)).toBe(1);
    expect(nextPunchPosition(punches([T0, T0 + 4 * HOUR_MS, T0 + 4.5 * HOUR_MS]), true)).toBeNull();
  });

  it('goes from the clock in to the clock out with the lunch rows hidden', () => {
    expect(nextPunchPosition(emptyPunches(), false)).toBe(0);
    expect(nextPunchPosition(punches([T0, null, null, null]), false)).toBe(3);
    expect(nextPunchPosition(punches([T0, null, null, T0 + 8 * HOUR_MS]), false)).toBeNull();
    // Stepped out and back: with no lunch every pair sits before the clock out.
    expect(nextPunchPosition(punches([T0, null, null, T0 + 2 * HOUR_MS, null, null]), false)).toBe(4);
    expect(nextPunchPosition(punches([T0, null, null, T0 + 2 * HOUR_MS, T0 + 3 * HOUR_MS, null]), false)).toBe(5);
  });
});

describe('lunchRowsShown', () => {
  const off = { mealRules: false, lunchPunches: false };

  it('shows the lunch rows unless the meal periods and the lunch punches are both off', () => {
    expect(lunchRowsShown(emptyPunches(), { mealRules: true, lunchPunches: true })).toBe(true);
    expect(lunchRowsShown(emptyPunches(), { mealRules: true, lunchPunches: false })).toBe(true);
    expect(lunchRowsShown(emptyPunches(), { mealRules: false, lunchPunches: true })).toBe(true);
    expect(lunchRowsShown(emptyPunches(), off)).toBe(false);
    expect(lunchRowsShown(punches([T0, null, null, T0 + 8 * HOUR_MS]), off)).toBe(false);
  });

  it('keeps them on a day with a lunch punched, so the times stay in sight', () => {
    expect(lunchRowsShown(punches([T0, T0 + 4 * HOUR_MS, null, null]), off)).toBe(true);
    expect(lunchRowsShown(punches([T0, null, T0 + 4.5 * HOUR_MS, null]), off)).toBe(true);
  });
});

describe('lunchInPunchOrder', () => {
  const on = { mealRules: true, lunchPunches: true };
  const clockedIn = punches([T0, null, null, null]);
  const half = { ...settings, workMinutes: 240 };
  const inOrder = (p: Punch[], s: TimeclockSettings, now: number, rows = on) => lunchInPunchOrder(p, computeTimeclock(p, s, now), rows);

  it('with the meal periods on, leaves the lunch rows out only on a day that needs no lunch', () => {
    expect(inOrder(clockedIn, half, T0 + HOUR_MS)).toBe(false);
    expect(nextPunchPosition(clockedIn, false)).toBe(3);
    expect(inOrder(clockedIn, settings, T0 + HOUR_MS)).toBe(true); // upcoming
    expect(inOrder(clockedIn, settings, T0 + 5 * HOUR_MS + 10 * MINUTE_MS)).toBe(true); // overdue
    expect(inOrder(punches([T0, T0 + 2 * HOUR_MS, T0 + 2.5 * HOUR_MS, null]), half, T0 + 3 * HOUR_MS)).toBe(true); // taken
  });

  it('keeps them while shown with the meal periods off', () => {
    const noMeals = { ...settings, mealRules: false };
    expect(inOrder(clockedIn, noMeals, T0 + HOUR_MS, { mealRules: false, lunchPunches: true })).toBe(true);
    expect(inOrder(clockedIn, noMeals, T0 + HOUR_MS, { mealRules: false, lunchPunches: false })).toBe(false);
  });

  it('goes to the Clock out past the target with no lunch taken', () => {
    expect(inOrder(clockedIn, settings, T0 + 8 * HOUR_MS + 10 * MINUTE_MS)).toBe(false);
    expect(nextPunchPosition(clockedIn, false)).toBe(3);
  });

  it('keeps them at lunch past the target, so the Now is Lunch in', () => {
    const atLunch = punches([T0, T0 + 4 * HOUR_MS, null, null]);
    expect(inOrder(atLunch, half, T0 + 4 * HOUR_MS + 10 * MINUTE_MS)).toBe(true);
    expect(nextPunchPosition(atLunch, true)).toBe(2);
  });
});

describe('targetFraction', () => {
  it('is the share of the work day worked, and stays at 1 past it', () => {
    expect(targetFraction(computeTimeclock(emptyPunches(), settings, T0))).toBe(0);
    expect(targetFraction(computeTimeclock(punches([T0, null, null]), settings, T0 + 2 * HOUR_MS))).toBe(0.25);
    expect(targetFraction(computeTimeclock(punches([T0, null, null]), settings, T0 + 10 * HOUR_MS))).toBe(1);
  });
});
