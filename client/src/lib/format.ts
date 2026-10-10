import { addDays, MINUTE_MS, pad2, parseDateKey } from '../../../shared/dates.js';
import type { TimeFormat } from '../types';

// One formatter per clock; the locale decides everything else (separators, AM/PM spelling).
const timeFmt = (hourCycle: 'h12' | 'h23') => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', hourCycle });
const time12Fmt = timeFmt('h12');
const time24Fmt = timeFmt('h23');
const dateLongFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const dateFullFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
const dayShortFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' });

/** "8:32 AM" or "08:32", by the user's time format (`resolveHour12`). */
export function formatTime(ms: number, hour12: boolean): string {
  return (hour12 ? time12Fmt : time24Fmt).format(new Date(ms));
}

export function formatDateLong(key: string): string {
  return dateLongFmt.format(parseDateKey(key));
}

export function formatDateFull(key: string): string {
  return dateFullFmt.format(parseDateKey(key));
}

/** "September 2026" */
export function formatMonth(key: string): string {
  return monthFmt.format(parseDateKey(key));
}

/**
 * "Sep 14 – 20", "Sep 28 – Oct 4" (en-US), "14–20 Sept" (en-GB): an inclusive span of date keys
 * in the locale's own range pattern, which orders the day and month and adds the years when
 * they differ.
 */
export function formatDateSpan(from: string, to: string): string {
  return dayShortFmt.formatRange(parseDateKey(from), parseDateKey(to));
}

/**
 * "Today", "Yesterday", "Tomorrow", or the short date: how the sheet's date row and the calendar
 * name a day. `inSentence` lowercases the word for a line that runs on ("Still Open From yesterday").
 */
export function dayName(key: string, today: string, inSentence = false): string {
  const word = key === today ? 'Today' : key === addDays(today, -1) ? 'Yesterday' : key === addDays(today, 1) ? 'Tomorrow' : null;
  if (!word) return formatDateLong(key);
  return inSentence ? word.toLowerCase() : word;
}

/** "Wed" */
export function formatWeekday(key: string): string {
  return weekdayFmt.format(parseDateKey(key));
}

/** "15 min", "1h 30m", "2h": a length in minutes the way the alarm banners write it. */
export function formatMinutes(m: number): string {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
}

/** "1h 12m", "45m", "0m". Negative values are shown as positive. */
export function formatDuration(seconds: number): string {
  const s = Math.abs(Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${pad2(m)}m`;
}

/** "7:39": hours and minutes on one line, for a cell too narrow for "7h 39m". */
export function formatHours(seconds: number): string {
  const s = Math.abs(Math.round(seconds));
  return `${Math.floor(s / 3600)}:${pad2(Math.floor((s % 3600) / 60))}`;
}

/** "1h 12m" but rounds up so "in 1m" never reads "in 0m" while seconds remain. */
export function formatDurationCeil(seconds: number): string {
  return formatDuration(Math.ceil(Math.abs(seconds) / 60) * 60);
}

/** mm:ss, or h:mm:ss above an hour; a negative count (a timer past its end) gets a leading minus. */
export function formatCountdown(seconds: number): string {
  const s = Math.abs(Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const sign = Math.round(seconds) < 0 ? '−' : '';
  return `${sign}${h > 0 ? `${h}:${pad2(m)}:${pad2(sec)}` : `${m}:${pad2(sec)}`}`;
}

/** Whether times get AM/PM: the setting, or for 'auto' whatever the browser locale does. */
export function resolveHour12(pref: TimeFormat): boolean {
  if (pref === '12h') return true;
  if (pref === '24h') return false;
  // `hour12` is always resolved once `hour` is in the options; the comparison keeps 12-hour as the default.
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12 !== false;
}

/**
 * The start of the minute (punch times are minute-granular in the UI). Down, never to the
 * nearest: a Now at 8:59:40 is 8:59, so a punch never lands in the future.
 */
export function floorToMinute(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/** The word for `n` of something: "day" for 1, "days" otherwise. */
export function plural(n: number, one: string): string {
  return n === 1 ? one : `${one}s`;
}

/** `n` with its word: "1 day", "3 days". */
export function counted(n: number, one: string): string {
  return `${n} ${plural(n, one)}`;
}
