import type { Punch, Settings } from '../types';

export type TimeclockState = 'not-started' | 'working' | 'at-lunch' | 'on-break' | 'done';
export type LunchStatus = 'none' | 'upcoming' | 'overdue' | 'taken';
export type ClockOutStatus = 'none' | 'upcoming' | 'over' | 'done';

export type TimeclockSettings = Pick<Settings, 'workMinutes' | 'lunchDeadlineMinutes' | 'lunchMinutes'>;

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
  /** Set when punch times don't alternate in/out chronologically. */
  error: string | null;
}

export const LUNCH_OUT_POSITION = 1;
export const LUNCH_IN_POSITION = 2;

export function kindForPosition(position: number): 'in' | 'out' {
  return position % 2 === 0 ? 'in' : 'out';
}

const MIN = 60_000;

/**
 * Pure timeclock math. `punches` are the fixed-position rows (0 clock in, 1 lunch out,
 * 2 lunch in, 3+ extra out/in pairs); unset rows have `at: null`. Set punches are
 * evaluated in chronological order so an extra break can be logged before lunch.
 */
export interface TimeclockOptions {
  /** A past day: once off the clock it is done, whatever the target was. */
  frozen?: boolean;
}

export function computeTimeclock(
  punches: Punch[],
  settings: TimeclockSettings,
  now: number,
  opts: TimeclockOptions = {},
): TimeclockResult {
  const byPos = new Map(punches.map((p) => [p.position, p.at]));
  const clockIn = byPos.get(0) ?? null;
  const lunchOut = byPos.get(LUNCH_OUT_POSITION) ?? null;
  const lunchIn = byPos.get(LUNCH_IN_POSITION) ?? null;
  const workTarget = settings.workMinutes * 60;
  const lunchSeconds = settings.lunchMinutes * 60;

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
      if (openIn != null) workedMs += Math.max(0, p.at - openIn);
      openIn = null;
      lastOut = p.at;
      expect = 'in';
    }
  }

  const clockedIn = openIn != null;
  if (clockedIn) workedMs += Math.max(0, effectiveNow - openIn!);
  const workedSeconds = Math.floor(workedMs / 1000);
  const remainingSeconds = Math.max(0, workTarget - workedSeconds);
  const overSeconds = Math.max(0, workedSeconds - workTarget);

  const atLunch = !clockedIn && lunchOut != null && lunchIn == null && lastOut === lunchOut;
  const done = !clockedIn && (remainingSeconds === 0 || (opts.frozen === true && lastOut != null));
  const openOffMs = !clockedIn && lastOut != null && !done ? Math.max(0, effectiveNow - lastOut) : 0;
  const offClockSeconds = Math.floor((offClosedMs + openOffMs) / 1000);

  const state: TimeclockState = error
    ? 'working'
    : done
      ? 'done'
      : clockedIn
        ? 'working'
        : atLunch
          ? 'at-lunch'
          : 'on-break';

  const lunchBy = clockIn + settings.lunchDeadlineMinutes * MIN;
  const lunchStatus: LunchStatus = lunchOut != null ? 'taken' : now < lunchBy ? 'upcoming' : 'overdue';

  // Time still expected off the clock before the day can end.
  const futureOffSeconds =
    lunchOut == null ? lunchSeconds : lunchIn == null && atLunch ? Math.max(0, lunchSeconds - openOffMs / 1000) : 0;

  let clockOutAt: number | null;
  let clockOutStatus: ClockOutStatus;
  if (done) {
    clockOutAt = lastOut;
    clockOutStatus = 'done';
  } else if (remainingSeconds > 0) {
    clockOutAt = effectiveNow + (remainingSeconds + futureOffSeconds) * 1000;
    clockOutStatus = 'upcoming';
  } else {
    clockOutAt = effectiveNow - overSeconds * 1000;
    clockOutStatus = 'over';
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
    error,
  };
}

/** Empty punch rows for a fresh day: clock in, lunch out, lunch in. */
export function emptyPunches(): Punch[] {
  return [0, 1, 2].map((position) => ({ position, kind: kindForPosition(position), at: null }));
}

/** Ensure the three fixed rows exist and positions are contiguous. */
export function normalizePunches(punches: Punch[]): Punch[] {
  const byPos = new Map(punches.map((p) => [p.position, p.at]));
  const max = Math.max(2, ...punches.map((p) => p.position));
  const out: Punch[] = [];
  for (let i = 0; i <= max; i++) out.push({ position: i, kind: kindForPosition(i), at: byPos.get(i) ?? null });
  return out;
}
