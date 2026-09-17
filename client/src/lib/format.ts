const pad = (n: number) => String(n).padStart(2, '0');

/** Local-date key, e.g. 2026-09-16. The client owns "today"; the server never guesses. */
export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayKey(now: number = Date.now()): string {
  return dateKey(new Date(now));
}

/** Midnight (local) for a date key. */
export function parseDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

export function isValidDateKey(key: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const d = parseDateKey(key);
  return dateKey(d) === key;
}

export function addDays(key: string, n: number): string {
  const d = parseDateKey(key);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}

export function endOfDay(key: string): number {
  const d = parseDateKey(key);
  d.setDate(d.getDate() + 1);
  return d.getTime() - 1;
}

/** Monday of the key's week: the review follows the work week, not the calendar one. */
export function startOfWeek(key: string): string {
  const d = parseDateKey(key);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return dateKey(d);
}

export function startOfMonth(key: string): string {
  return `${key.slice(0, 7)}-01`;
}

export function startOfQuarter(key: string): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return `${y}-${pad(Math.floor((m - 1) / 3) * 3 + 1)}-01`;
}

/** `n` months from the first of the key's month, clamped to a first-of-month key. */
export function addMonths(key: string, n: number): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return dateKey(new Date(y, m - 1 + n, 1));
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dateLongFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const dateFullFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
const dayShortFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' });

export function formatTime(ms: number): string {
  return timeFmt.format(new Date(ms));
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

/** "Sep 14 – 20" or "Sep 28 – Oct 4": an inclusive span of date keys. */
export function formatDateSpan(from: string, to: string): string {
  const a = parseDateKey(from);
  const b = parseDateKey(to);
  if (from.slice(0, 7) === to.slice(0, 7)) return `${dayShortFmt.format(a)} – ${b.getDate()}`;
  return `${dayShortFmt.format(a)} – ${dayShortFmt.format(b)}`;
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

/** "1h 12m" but rounds up so "in 1m" never reads "in 0m" while seconds remain. */
export function formatDurationCeil(seconds: number): string {
  return formatDuration(Math.ceil(Math.abs(seconds) / 60) * 60);
}

/** mm:ss, or h:mm:ss above an hour. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Value for <input type="time"> from an epoch ms, in local time. */
export function toTimeInput(ms: number | null): string {
  if (ms == null) return '';
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Epoch ms for a "HH:MM" on the given local date; null when empty/invalid. */
export function fromTimeInput(key: string, value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const d = parseDateKey(key);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return d.getTime();
}

/** Round to the nearest minute (punch times are minute-granular in the UI). */
export function roundToMinute(ms: number): number {
  return Math.round(ms / 60_000) * 60_000;
}
