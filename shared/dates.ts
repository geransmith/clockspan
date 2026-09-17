/**
 * Date keys (`YYYY-MM-DD`) and the arithmetic on them. The client owns "today" (a key is
 * always the browser's local date); the server only ever validates a key it was sent, and
 * `isValidDateKey` is zone-free so that holds in any container TZ.
 */

const pad = (n: number) => String(n).padStart(2, '0');
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Local-date key, e.g. 2026-09-16. */
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

/** Shape and calendar validity (no Feb 30), checked in UTC so the answer never depends on the zone. */
export function isValidDateKey(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_KEY_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const HOUR_MS = 3_600_000;

/**
 * The epoch range a punch on this key can plausibly have, whatever zone wrote it. The UI
 * only ever places a time on the key's own local day; with zones from UTC-12 to UTC+14 every
 * such instant lies within the key's UTC midnight -14 h .. +36 h, so a day of slack either
 * side is generous. Computed in UTC like `isValidDateKey`, so the server never needs a zone.
 */
export function punchWindow(key: string): { from: number; to: number } {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const midnightUtc = Date.UTC(y, m - 1, d);
  return { from: midnightUtc - 36 * HOUR_MS, to: midnightUtc + 60 * HOUR_MS };
}

export function addDays(key: string, n: number): string {
  const d = parseDateKey(key);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}

/** Last millisecond of the key's local day. */
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
