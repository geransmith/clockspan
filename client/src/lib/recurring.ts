/**
 * The morning offer's recurring half: which recurring priorities are due on a day and not on
 * its list yet (`dueRecurring`, `notOnList`), which of them the offer ticks (`offerPicks`, up to
 * `recurringPerDay`) and the list after Add to today (`acceptOffer`). The answers this device
 * gave today are `useRecurringAnswered`'s. Pure: the clock comes in as `now`.
 */
import type { Priority, Recurring } from '../types';
import { isoWeekday } from '../../../shared/dates.js';
import { seedRow, type PrioritySeed } from './plan';
import { newTaskRow, padPriorities, placePriority } from './priorities';

/** The items no row on `rows` is yet, in the order given: a row is its task's whatever its draft text. */
export function notOnList(items: Recurring[], rows: Priority[]): Recurring[] {
  return items.filter((r) => !rows.some((p) => p.uid === r.uid));
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

/** The recurring priorities' rows on a list. */
export function recurringCount(rows: Priority[]): number {
  return rows.filter((p) => p.recurring).length;
}

/**
 * The due items the offer ticks: the first ones, in order, up to `perDay` less the routines
 * already on `onToday`, never fewer than none. The rest show unticked.
 */
export function offerPicks(due: Recurring[], onToday: Priority[], perDay: number): Set<string> {
  const room = Math.max(0, perDay - recurringCount(onToday));
  return new Set(due.slice(0, room).map((r) => r.uid));
}

/**
 * The row the offer adds for `item`: the recurring priority itself, new to today. Its name,
 * category and note show as the board has them until the save answers. A save never writes them
 * back onto the task: it renames a task only where the row's text differs from the list it was
 * built on.
 */
export function recurringRow(item: Recurring, now: number): Omit<Priority, 'position'> {
  return { ...newTaskRow(item.title, item.categoryUid, now), uid: item.uid, note: item.note, recurring: true };
}

/**
 * The list after Add to today: each seed (the leftovers, then the tasks from Up next) through
 * `placePriority` (`seedRow`), in the first free row of the list padded to `count`, then each
 * routine through `placePriority` with `end`, after every row of the padded list, so the free base
 * rows stay for one-offs. Nothing written moves, so routines another device added after the free
 * rows stay there. Either skips a task a row of the list is already, and one that doesn't fit (a
 * full list).
 */
export function acceptOffer(rows: Priority[], count: number, seeds: PrioritySeed[], recurring: Recurring[], now: number): Priority[] {
  let list = padPriorities(rows, count);
  for (const seed of seeds) list = placePriority(list, count, seedRow(seed, now)) ?? list;
  for (const item of recurring) list = placePriority(list, count, recurringRow(item, now), { end: true }) ?? list;
  return list;
}
