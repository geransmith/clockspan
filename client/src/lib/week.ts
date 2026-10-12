import type { Day } from '../types';
import { dayTimeclock, type TimeclockSettings } from './timeclock';

export interface WeekHours {
  /**
   * Worked from Monday up to and including the day, by the same math as each day's sheet. A day
   * whose punches are out of order, or an earlier one left clocked in (`unclosed`), counts nothing:
   * its sheet shows no worked time either.
   */
  workedSeconds: number;
  targetSeconds: number;
  /** A target is set and the week has reached it. */
  met: boolean;
  /**
   * Worked past the target, once that is a whole minute: under that the line would read
   * "0m over" just as the target is reached. 0 without a target.
   */
  overSeconds: number;
  /** The dates of the earlier days left clocked in, in the order `days` came in. */
  unclosed: string[];
}

/**
 * The week so far: `days` are that week's from Monday up to the day on screen (the sheet reads
 * them through `useRange`), each worked out like its own sheet (its own length, frozen once
 * past), against the weekly target.
 */
export function weekHours(days: Day[], settings: TimeclockSettings & { weekMinutes: number }, today: string, now: number): WeekHours {
  let workedSeconds = 0;
  const unclosed: string[] = [];
  for (const d of days) {
    const tc = dayTimeclock(d, settings, today, now);
    if (tc.unclosed) unclosed.push(d.date);
    else if (!tc.outOfOrder) workedSeconds += tc.workedSeconds;
  }
  const targetSeconds = settings.weekMinutes * 60;
  const over = workedSeconds - targetSeconds;
  return {
    workedSeconds,
    targetSeconds,
    met: targetSeconds > 0 && workedSeconds >= targetSeconds,
    overSeconds: targetSeconds > 0 && over >= 60 ? over : 0,
    unclosed,
  };
}
