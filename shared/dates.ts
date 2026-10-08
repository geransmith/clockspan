/**
 * Date keys (`YYYY-MM-DD`) and the arithmetic on them. The client owns "today" (a key is
 * always the browser's local date); the server only ever validates a key it was sent, and
 * `isValidDateKey` is zone-free so that holds in any container TZ.
 */

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "07": a month, day, hour or minute in two digits. */
export const pad2 = (n: number): string => String(n).padStart(2, '0');

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
/** A calendar day's length in UTC; a local day across a DST change is an hour off it. */
export const DAY_MS = 24 * HOUR_MS;

/** Local-date key, e.g. 2026-09-16. */
function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function todayKey(now: number = Date.now()): string {
  return dateKey(new Date(now));
}

/** The key's first local instant: midnight, or 01:00 where the zone skips midnight. */
export function parseDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

/** Shape and calendar validity (no Feb 30), checked in UTC so the answer never depends on the zone. */
export function isValidDateKey(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_KEY_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * The epoch range a punch on this key can plausibly have, whatever zone wrote it. The UI
 * only ever places a time on the key's own local day; with zones from UTC-12 to UTC+14 every
 * such instant lies within the key's UTC midnight -14 h .. +36 h. The window is the key's UTC
 * noon ± 48 h (-36 h .. +60 h), which leaves 22 h to spare before that span and 24 h after it.
 * Computed in UTC like `isValidDateKey`, so the server never needs a zone.
 */
export function punchWindow(key: string): { from: number; to: number } {
  // A date-only key parses as UTC midnight (see daysBetween).
  const midnightUtc = Date.parse(key);
  return { from: midnightUtc - 36 * HOUR_MS, to: midnightUtc + 60 * HOUR_MS };
}

/**
 * Whole days from `from` to `to`, negative when `to` is earlier. A date-only key parses as UTC
 * midnight, so a DST change never shifts it by an hour.
 */
export function daysBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / DAY_MS;
}

export function addDays(key: string, n: number): string {
  const d = parseDateKey(key);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}

/** Saturday or Sunday on the key's local date. */
export function isWeekend(key: string): boolean {
  const wd = parseDateKey(key).getDay();
  return wd === 0 || wd === 6;
}

/**
 * The instant for a local wall-clock time on the key's date (seconds dropped). A time in the
 * hour a spring-forward day skips lands an hour later, because setHours moves it forward.
 */
export function atTime(key: string, hour: number, minute: number): number {
  const d = parseDateKey(key);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

/**
 * Last millisecond of the key's local day: one before the next day's first instant. Not this
 * day's midnight plus a day: where a zone skips its own midnight (Chile, Cuba, Egypt, Lebanon
 * change clocks at 00:00), parseDateKey answers 01:00 and setDate would carry that hour into
 * the next day.
 */
export function endOfDay(key: string): number {
  return parseDateKey(addDays(key, 1)).getTime() - 1;
}

/**
 * ISO weekday of a date key, Monday 1 … Sunday 7, as a recurring priority's schedule names it.
 * Computed in UTC from the key (a date-only key parses as UTC midnight, see daysBetween), so the
 * zone never matters.
 */
export function isoWeekday(key: string): number {
  return ((new Date(Date.parse(key)).getUTCDay() + 6) % 7) + 1;
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
  return `${y}-${pad2(Math.floor((m - 1) / 3) * 3 + 1)}-01`;
}

/** `n` months from the first of the key's month, clamped to a first-of-month key. */
export function addMonths(key: string, n: number): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return dateKey(new Date(y, m - 1 + n, 1));
}
