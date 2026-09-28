import type { Day } from '../types';
import { startOfWeek } from './format';
import { daySettings, timeclockForDate, type TimeclockSettings } from './timeclock';

export interface WeekHours {
  /** Worked from Monday up to and including the day, by the same math as each day's sheet. */
  workedSeconds: number;
  targetSeconds: number;
  /** A target is set and the week has reached it. */
  met: boolean;
}

/**
 * The week so far as the sheet for `date` sees it: the days from that week's Monday up to
 * `date`, each worked out like its own sheet (its own length, frozen once past), against the
 * weekly target. Days outside that span are ignored, so a caller can hand over whatever it holds.
 */
export function weekHours(days: Day[], settings: TimeclockSettings & { weekMinutes: number }, date: string, today: string, now: number): WeekHours {
  const from = startOfWeek(date);
  let workedSeconds = 0;
  for (const d of days) {
    if (d.date < from || d.date > date) continue;
    workedSeconds += timeclockForDate(d.punches, daySettings(settings, d), d.date, today, now).workedSeconds;
  }
  const targetSeconds = settings.weekMinutes * 60;
  return { workedSeconds, targetSeconds, met: targetSeconds > 0 && workedSeconds >= targetSeconds };
}
