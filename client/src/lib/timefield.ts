import { Time } from '@internationalized/date';
import { atTime } from '../../../shared/dates.js';

export type Period = 'AM' | 'PM';

/** The local wall-clock hour and minute of an instant, as the time field edits them. */
export function msToTime(ms: number | null): Time | null {
  if (ms == null) return null;
  const d = new Date(ms);
  return new Time(d.getHours(), d.getMinutes());
}

/** The instant for a time field's value on the given local date (see `atTime`). */
export function timeToMs(t: Time, dateKey: string): number {
  return atTime(dateKey, t.hour, t.minute);
}

/**
 * The likely period for an hour typed without one. Working hours read as a day job: 5 to
 * 11 is morning, 12 and 1 to 4 is afternoon. When the day's clock-in is known (`anchorAt`)
 * a later punch comes after it, so a morning guess becomes afternoon when every minute of
 * that morning hour is before the clock-in and the afternoon hour is not. An afternoon guess
 * stays: the same hour in the morning is earlier still. One keystroke on the segment flips it.
 * The guess is made as the hour is typed, before the minute, so an hour counts as after the
 * clock-in when any minute of it is: 8 after an 8:30 clock-in can still be 8:50 AM.
 */
export function guessPeriod(hour12: number, dateKey: string, anchorAt: number | null): Period {
  const base: Period = hour12 >= 5 && hour12 <= 11 ? 'AM' : 'PM';
  if (anchorAt == null) return base;
  const at = (p: Period) => timeToMs(new Time(hour24(hour12, p), 59), dateKey);
  return base === 'AM' && at('AM') < anchorAt && at('PM') >= anchorAt ? 'PM' : base;
}

function hour24(hour12: number, period: Period): number {
  const h = hour12 % 12;
  return period === 'PM' ? h + 12 : h;
}
