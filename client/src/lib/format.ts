import { addDays, parseDateKey } from '../../../shared/dates.js';
import type { TimeFormat } from '../../../shared/settings.js';

export {
  addDays,
  addMonths,
  dateKey,
  endOfDay,
  isValidDateKey,
  parseDateKey,
  startOfMonth,
  startOfQuarter,
  startOfWeek,
  todayKey,
} from '../../../shared/dates.js';

const pad = (n: number) => String(n).padStart(2, '0');

// One formatter per clock; the locale decides everything else (separators, AM/PM spelling).
const timeFmts = new Map<boolean, Intl.DateTimeFormat>();
const dateLongFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const dateFullFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
const dayShortFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' });

/** "8:32 AM" or "08:32", by the user's time format (`resolveHour12`). */
export function formatTime(ms: number, hour12: boolean): string {
  let fmt = timeFmts.get(hour12);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', hourCycle: hour12 ? 'h12' : 'h23' });
    timeFmts.set(hour12, fmt);
  }
  return fmt.format(new Date(ms));
}

export function formatDateLong(key: string): string {
  return dateLongFmt.format(parseDateKey(key));
}

export function formatDateFull(key: string): string {
  return dateFullFmt.format(parseDateKey(key));
}

/** "Sep 16": the day without its weekday, for a line that writes the weekday itself. */
export function formatDateShort(key: string): string {
  return dayShortFmt.format(parseDateKey(key));
}

/** "September 2026" */
export function formatMonth(key: string): string {
  return monthFmt.format(parseDateKey(key));
}

/** "Sep 14 – 20" or "Sep 28 – Oct 4": an inclusive span of date keys. */
export function formatDateSpan(from: string, to: string): string {
  const a = parseDateKey(from);
  const b = parseDateKey(to);
  if (from.slice(0, 7) === to.slice(0, 7)) return `${dayShortFmt.format(a)} – ${b.getDate()}`;
  return `${dayShortFmt.format(a)} – ${dayShortFmt.format(b)}`;
}

/** "Today", "Yesterday", or the short date: how the header and the history list name a day. */
export function dayName(key: string, today: string): string {
  if (key === today) return 'Today';
  if (key === addDays(today, -1)) return 'Yesterday';
  return formatDateLong(key);
}

/** "Wed" */
export function formatWeekday(key: string): string {
  return weekdayFmt.format(parseDateKey(key));
}

/** "1h 12m", "45m", "0m". Negative values are shown as positive. */
export function formatDuration(seconds: number): string {
  const s = Math.abs(Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${pad(m)}m`;
}

/** "7:39": hours and minutes on one line, for a cell too narrow for "7h 39m". */
export function formatHours(seconds: number): string {
  const s = Math.abs(Math.round(seconds));
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}`;
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
  return `${sign}${h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`}`;
}

/** Whether times get AM/PM: the setting, or for 'auto' whatever the browser locale does. */
export function resolveHour12(pref: TimeFormat = 'auto'): boolean {
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
  return Math.floor(ms / 60_000) * 60_000;
}
