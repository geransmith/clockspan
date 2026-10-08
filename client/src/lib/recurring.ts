/**
 * The morning offer's recurring half: which recurring priorities are due on a day and not on
 * its list yet (`dueRecurring`, `notOnList`), which of them the offer ticks (`offerPicks`, up to
 * `recurringPerDay`), the list after Add to today (`acceptOffer`), and the answers this device
 * gave today (`readAnswered`, `writeAnswered`), which `useRecurringAnswered` keeps. Pure: the
 * clock comes in as `now`.
 */
import type { Priority, Recurring } from '../types';
import { isoWeekday } from '../../../shared/dates.js';
import { hasText } from '../../../shared/priorities.js';
import { planNext, type PrioritySeed } from './plan';
import { isRecurring, newUid, padPriorities, placePriority } from './priorities';

/**
 * The items no row with text on `rows` holds yet, in the order given. An emptied row holding one
 * doesn't hide it: Add to today takes that row back.
 */
export function notOnList(items: Recurring[], rows: Priority[]): Recurring[] {
  return items.filter((r) => !rows.some((p) => hasText(p) && p.recurringUid === r.uid));
}

/**
 * The items due on `date` (its ISO weekday is one of theirs), in the order given (Settings
 * order), less those answered on this device today and those on `rows` already (`notOnList`).
 */
export function dueRecurring(items: Recurring[], date: string, rows: Priority[], answered: ReadonlySet<string>): Recurring[] {
  const weekday = isoWeekday(date);
  return notOnList(
    items.filter((r) => r.weekdays.includes(weekday) && !answered.has(r.uid)),
    rows,
  );
}

/** The rows with text on a list that came from a recurring priority. */
export function recurringCount(rows: Priority[]): number {
  return rows.filter((p) => hasText(p) && isRecurring(p)).length;
}

/**
 * The due items the offer ticks: the first ones, in order, up to `perDay` less the routines
 * already on `onToday`, never fewer than none. The rest show unticked.
 */
export function offerPicks(due: Recurring[], onToday: Priority[], perDay: number): Set<string> {
  const room = Math.max(0, perDay - recurringCount(onToday));
  return new Set(due.slice(0, room).map((r) => r.uid));
}

/** The row the offer adds for `item`: its title and category, linked to it, on no card, new to today. */
export function recurringRow(item: Recurring, now: number): Omit<Priority, 'position'> {
  return { text: item.title, done: false, uid: newUid(), addedAt: now, cardUid: null, recurringUid: item.uid, categoryUid: item.categoryUid };
}

/**
 * The list after Add to today: the leftovers through `planNext` (then padded to `count`), then
 * each routine through `placePriority` with `end`, after every row of the padded list, so the
 * empty base rows stay for one-offs. Either takes back an emptied row holding its link and skips
 * one a row with text already holds. A routine that doesn't fit (a full list) is skipped. With no
 * leftovers picked `planNext` is skipped, since it drops the rows never written in: a free row
 * between written ones stays where it is, and nothing is renumbered.
 */
export function acceptOffer(rows: Priority[], count: number, leftovers: PrioritySeed[], recurring: Recurring[], now: number): Priority[] {
  let list = padPriorities(leftovers.length ? planNext(rows, leftovers, now).rows : rows, count);
  for (const item of recurring) list = placePriority(list, count, recurringRow(item, now), { end: true }) ?? list;
  return list;
}

const ANSWERED_RE = /^(\d{4}-\d{2}-\d{2}) (.*)$/;

/**
 * The recurring priorities answered (added or not) on this device on `date`, from what
 * `writeAnswered` stored: "YYYY-MM-DD uid,uid". Empty for another date, nothing stored, or
 * anything else, so a new day starts with none.
 */
export function readAnswered(raw: string | null, date: string): Set<string> {
  const m = raw == null ? null : ANSWERED_RE.exec(raw);
  if (!m || m[1] !== date) return new Set();
  return new Set(m[2]!.split(',').filter((uid) => uid !== ''));
}

/** What `readAnswered` reads back: the date and each uid once. */
export function writeAnswered(date: string, uids: Iterable<string>): string {
  return `${date} ${[...new Set(uids)].join(',')}`;
}
