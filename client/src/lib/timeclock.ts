import { endOfDay } from '../../../shared/dates.js';
import type { Punch, Settings } from '../types';

export type TimeclockState = 'not-started' | 'working' | 'at-lunch' | 'on-break' | 'done';
export type LunchStatus = 'none' | 'upcoming' | 'overdue' | 'taken';
export type ClockOutStatus = 'none' | 'upcoming' | 'over' | 'done';
export type SecondMealStatus = 'none' | 'upcoming' | 'overdue' | 'taken';

export type TimeclockSettings = Pick<Settings, 'workMinutes' | 'lunchDeadlineMinutes' | 'lunchMinutes' | 'secondMealAfterMinutes'>;

export interface TimeclockResult {
  state: TimeclockState;
  clockIn: number | null;
  lunchOut: number | null;
  lunchIn: number | null;
  /** Deadline by which lunch must start (clockIn + lunchDeadlineMinutes). */
  lunchBy: number | null;
  lunchStatus: LunchStatus;
  workedSeconds: number;
  /** Closed + open time off the clock since clock-in. */
  offClockSeconds: number;
  remainingSeconds: number;
  /** Seconds worked beyond the target (0 while under). */
  overSeconds: number;
  /**
   * When the workday will end. Stable while working; while at lunch/on a break it moves
   * later as the break runs long. Null before clock-in. Once the target is reached it is
   * the instant it was reached, so alarms have a fixed anchor.
   */
  clockOutAt: number | null;
  clockOutStatus: ClockOutStatus;
  /**
   * When worked time reaches `secondMealAfterMinutes` (California: a second meal period is
   * due before the end of the 10th hour worked). Same behaviour as `clockOutAt`: fixed while
   * working, drifts on a break, anchored once passed. Null before clock-in or when done.
   */
  secondMealBy: number | null;
  /** 'taken' once any non-lunch break starts after lunch out. */
  secondMealStatus: SecondMealStatus;
  /** Set when punch times don't alternate in/out chronologically. */
  error: string | null;
}

export const LUNCH_OUT_POSITION = 1;
export const LUNCH_IN_POSITION = 2;
/** The clock-out row is the last row and never earlier than this. */
export const CLOCK_OUT_MIN_POSITION = 3;

export function kindForPosition(position: number): 'in' | 'out' {
  return position % 2 === 0 ? 'in' : 'out';
}

const MIN = 60_000;

/**
 * Position of the final clock-out row: the last row, which `normalizePunches` keeps at an
 * odd position ≥ 3. Null for un-normalized input (old data, tests).
 */
export function clockOutPosition(punches: Punch[]): number | null {
  const last = Math.max(-1, ...punches.map((p) => p.position));
  return last >= CLOCK_OUT_MIN_POSITION && last % 2 === 1 ? last : null;
}

export interface TimeclockOptions {
  /** A past day: once off the clock it is done, whatever the target was. */
  frozen?: boolean;
}

/**
 * Pure timeclock math. `punches` are the fixed-position rows (0 clock in, 1 lunch out,
 * 2 lunch in, 3+ extra out/in pairs, last = clock out); unset rows have `at: null`. Set
 * punches are evaluated in chronological order, so storage order never matters: an extra
 * break can be logged before lunch and the clock-out row can be re-punched after a return.
 */
export function computeTimeclock(punches: Punch[], settings: TimeclockSettings, now: number, opts: TimeclockOptions = {}): TimeclockResult {
  const byPos = new Map(punches.map((p) => [p.position, p.at]));
  const clockIn = byPos.get(0) ?? null;
  const lunchOut = byPos.get(LUNCH_OUT_POSITION) ?? null;
  const lunchIn = byPos.get(LUNCH_IN_POSITION) ?? null;
  const finalPos = clockOutPosition(punches);
  const finalOut = finalPos == null ? null : (byPos.get(finalPos) ?? null);
  const workTarget = settings.workMinutes * 60;
  const lunchSeconds = settings.lunchMinutes * 60;
  const secondMealTarget = settings.secondMealAfterMinutes * 60;

  const empty: TimeclockResult = {
    state: 'not-started',
    clockIn,
    lunchOut,
    lunchIn,
    lunchBy: null,
    lunchStatus: 'none',
    workedSeconds: 0,
    offClockSeconds: 0,
    remainingSeconds: workTarget,
    overSeconds: 0,
    clockOutAt: null,
    clockOutStatus: 'none',
    secondMealBy: null,
    secondMealStatus: 'none',
    error: null,
  };
  if (clockIn == null) return empty;

  const set = punches
    .filter((p): p is Punch & { at: number } => p.at != null)
    .map((p) => ({ position: p.position, kind: kindForPosition(p.position), at: p.at }))
    .sort((a, b) => a.at - b.at || a.position - b.position);

  // Never let a future clock-in produce negative time.
  const effectiveNow = Math.max(now, clockIn);

  let error: string | null = null;
  let workedMs = 0;
  let offClosedMs = 0;
  let openIn: number | null = null;
  let lastOut: number | null = null;
  let expect: 'in' | 'out' = 'in';
  for (const p of set) {
    if (p.kind !== expect) {
      error = 'Punch times are out of order — check that ins and outs alternate.';
      break;
    }
    if (p.kind === 'in') {
      if (lastOut != null) offClosedMs += Math.max(0, p.at - lastOut);
      openIn = p.at;
      expect = 'out';
    } else {
      // `expect` only reaches 'out' after an 'in' set `openIn`.
      workedMs += Math.max(0, p.at - openIn!);
      openIn = null;
      lastOut = p.at;
      expect = 'in';
    }
  }

  const clockedIn = openIn != null;
  if (clockedIn) workedMs += Math.max(0, effectiveNow - openIn!);
  const workedSeconds = Math.floor(workedMs / 1000);
  // The part of the worked time the floor dropped. The targets below are "now plus what is
  // left", so without it they would carry the sub-second phase of `now` and land on a
  // different millisecond every tick; the alarm keys round to the minute and would flip
  // between two minutes for a target that sits within a second of :30.
  const subSecondMs = workedMs - workedSeconds * 1000;
  const remainingSeconds = Math.max(0, workTarget - workedSeconds);
  const overSeconds = Math.max(0, workedSeconds - workTarget);

  const atLunch = !clockedIn && lunchOut != null && lunchIn == null && lastOut === lunchOut;
  // The day is over when the target is met, when the explicit Clock out row is the latest
  // punch (leaving early is still leaving), or on a past day once off the clock.
  const done = !clockedIn && (remainingSeconds === 0 || (finalOut != null && lastOut === finalOut) || (opts.frozen === true && lastOut != null));
  const openOffMs = !clockedIn && lastOut != null && !done ? Math.max(0, effectiveNow - lastOut) : 0;
  const offClockSeconds = Math.floor((offClosedMs + openOffMs) / 1000);

  const state: TimeclockState = error ? 'working' : done ? 'done' : clockedIn ? 'working' : atLunch ? 'at-lunch' : 'on-break';

  const lunchBy = clockIn + settings.lunchDeadlineMinutes * MIN;
  const lunchStatus: LunchStatus = lunchOut != null ? 'taken' : now < lunchBy ? 'upcoming' : 'overdue';

  // Time still expected off the clock before the day can end.
  const futureOffSeconds = lunchOut == null ? lunchSeconds : lunchIn == null && atLunch ? Math.max(0, lunchSeconds - openOffMs / 1000) : 0;

  let clockOutAt: number | null;
  let clockOutStatus: ClockOutStatus;
  if (done) {
    clockOutAt = lastOut;
    clockOutStatus = 'done';
  } else if (remainingSeconds > 0) {
    clockOutAt = effectiveNow - subSecondMs + (remainingSeconds + futureOffSeconds) * 1000;
    clockOutStatus = 'upcoming';
  } else {
    clockOutAt = effectiveNow - subSecondMs - overSeconds * 1000;
    clockOutStatus = 'over';
  }

  // Worked time and `now` advance together while clocked in, so this is a fixed instant
  // while working and only drifts later during a break.
  let secondMealBy: number | null = null;
  let secondMealStatus: SecondMealStatus = 'none';
  if (!done) {
    secondMealBy = effectiveNow - subSecondMs + (secondMealTarget - workedSeconds) * 1000;
    const taken = lunchOut != null && set.some((p) => p.kind === 'out' && p.position !== LUNCH_OUT_POSITION && p.at > lunchOut);
    secondMealStatus = taken ? 'taken' : now < secondMealBy ? 'upcoming' : 'overdue';
  }

  return {
    state,
    clockIn,
    lunchOut,
    lunchIn,
    lunchBy,
    lunchStatus,
    workedSeconds,
    offClockSeconds,
    remainingSeconds,
    overSeconds,
    clockOutAt,
    clockOutStatus,
    secondMealBy,
    secondMealStatus,
    error,
  };
}

/** "Now" as a day sees it: live today, never past the end of an earlier day. */
export function clampToDay(date: string, today: string, now: number): number {
  return date === today ? now : Math.min(now, endOfDay(date));
}

/**
 * The timeclock for the sheet or a history row: today runs live; a past day is frozen at its
 * end so an unclosed clock-in doesn't count forever.
 */
export function timeclockForDate(punches: Punch[], settings: TimeclockSettings, date: string, today: string, now: number): TimeclockResult {
  return computeTimeclock(punches, settings, clampToDay(date, today, now), { frozen: date !== today });
}

/**
 * Whether the second meal period is in play: only while working, not yet taken, and only
 * when a day past the threshold is actually expected (overtime approved, already over the
 * target, or a target that long). A normal 8 h day never hears about it.
 */
export function secondMealApplies(tc: TimeclockResult, settings: Pick<Settings, 'workMinutes' | 'secondMealAfterMinutes'>, overtimeApproved: boolean): boolean {
  return (
    tc.state === 'working' &&
    tc.secondMealBy != null &&
    tc.secondMealStatus !== 'taken' &&
    (overtimeApproved || tc.overSeconds > 0 || settings.workMinutes >= settings.secondMealAfterMinutes)
  );
}

export interface ExtraPair {
  out: Punch;
  in: Punch;
  /** Where the card shows the pair; the math doesn't care. */
  beforeLunch: boolean;
}

/**
 * Extra out/in pairs (positions 3..clockOut-1) with their display placement. A pair added
 * while lunch isn't punched yet is assumed to be before lunch; once its out has a time, time
 * decides.
 */
export function extraPairs(punches: Punch[]): ExtraPair[] {
  const byPos = new Map(punches.map((p) => [p.position, p]));
  const lunchOut = byPos.get(LUNCH_OUT_POSITION)?.at ?? null;
  const last = clockOutPosition(punches);
  const pairs: ExtraPair[] = [];
  if (last == null) return pairs;
  for (let pos = CLOCK_OUT_MIN_POSITION; pos + 1 < last; pos += 2) {
    const out = byPos.get(pos);
    const back = byPos.get(pos + 1);
    if (!out || !back) break;
    pairs.push({ out, in: back, beforeLunch: lunchOut == null || (out.at != null && out.at < lunchOut) });
  }
  return pairs;
}

/** Empty punch rows for a fresh day: clock in, lunch out, lunch in, clock out. */
export function emptyPunches(): Punch[] {
  return [0, 1, 2, CLOCK_OUT_MIN_POSITION].map((position) => ({ position, kind: kindForPosition(position), at: null }));
}

/** Ensure the fixed rows exist, positions are contiguous and the last row is the clock out. */
export function normalizePunches(punches: Punch[]): Punch[] {
  const byPos = new Map(punches.map((p) => [p.position, p.at]));
  let max = Math.max(CLOCK_OUT_MIN_POSITION, ...punches.map((p) => p.position));
  // Days saved before the fixed Clock out row ended in an out/in pair. Dropping an unset
  // trailing "in" makes that pair's out the clock out instead of a stray break.
  if (max % 2 === 0 && byPos.get(max) == null) max -= 1;
  if (max % 2 === 0) max += 1;
  const out: Punch[] = [];
  for (let i = 0; i <= max; i++) out.push({ position: i, kind: kindForPosition(i), at: byPos.get(i) ?? null });
  return out;
}
