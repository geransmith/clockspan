import { Time } from '@internationalized/date';
import { parseDateKey } from '../../../shared/dates.js';

export type Period = 'AM' | 'PM';

/** The local wall-clock hour and minute of an instant, as the time field edits them. */
export function msToTime(ms: number | null): Time | null {
  if (ms == null) return null;
  const d = new Date(ms);
  return new Time(d.getHours(), d.getMinutes());
}

/** The instant for a wall-clock time on the given local date (seconds dropped). */
export function timeToMs(t: Time, dateKey: string): number {
  const d = parseDateKey(dateKey);
  d.setHours(t.hour, t.minute, 0, 0);
  return d.getTime();
}

/**
 * The likely period for an hour typed without one. Working hours read as a day job: 5 to
 * 11 is morning, 12 and 1 to 4 is afternoon. When the day's clock-in is known (`anchorAt`)
 * a later punch comes after it, so the other period wins if the guess would land before
 * the clock-in and the other period would not. One keystroke on the segment flips it.
 */
export function guessPeriod(hour12: number, minute: number, dateKey: string, anchorAt: number | null): Period {
  const base: Period = hour12 >= 5 && hour12 <= 11 ? 'AM' : 'PM';
  if (anchorAt == null) return base;
  const other: Period = base === 'AM' ? 'PM' : 'AM';
  const at = (p: Period) => timeToMs(new Time(hour24(hour12, p), minute), dateKey);
  return at(base) < anchorAt && at(other) >= anchorAt ? other : base;
}

function hour24(hour12: number, period: Period): number {
  const h = hour12 % 12;
  return period === 'PM' ? h + 12 : h;
}
