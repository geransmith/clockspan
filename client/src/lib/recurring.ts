/**
 * The recurring priorities: their days as a card's Repeat row and Later's Repeats show them
 * (`WEEKDAYS`, `repeatDays`), and the morning offer's recurring half: which are due on a day and
 * not on its list yet (`dueRecurring`, `notOnList`), which of them the offer ticks (`offerPicks`,
 * up to `recurringPerDay`) and the list after Add to Today (`acceptOffer`). The answers this
 * device gave today are `useRecurringAnswered`'s. Pure: the clock comes in as `now`.
 */
import type { Priority, Recurring } from '../types';
import { isoWeekday } from '../../../shared/dates.js';
import { seedRow, type PrioritySeed } from './plan';
import { newTaskRow, padPriorities, placePriority } from './priorities';

/** A recurring priority's days as the server numbers them (ISO, Monday 1), each a one-letter button named in full. */
export const WEEKDAYS = [
  { day: 1, letter: 'M', name: 'Monday' },
  { day: 2, letter: 'T', name: 'Tuesday' },
  { day: 3, letter: 'W', name: 'Wednesday' },
  { day: 4, letter: 'T', name: 'Thursday' },
  { day: 5, letter: 'F', name: 'Friday' },
  { day: 6, letter: 'S', name: 'Saturday' },
  { day: 7, letter: 'S', name: 'Sunday' },
] as const;

/**
 * A recurring priority's days, ascending as the server answers them, as Later's Repeats shows
 * them: three or more in a row as a span ("Mon–Fri"), the others one by one ("Mon, Wed, Fri").
 */
export function repeatDays(days: readonly number[]): string {
  const short = (day: number) => WEEKDAYS[day - 1]!.name.slice(0, 3);
  const runs: number[][] = [];
  for (const day of days) {
    const run = runs.at(-1);
    if (run?.at(-1) === day - 1) run.push(day);
    else runs.push([day]);
  }
  return runs.flatMap((run) => (run.length >= 3 ? [`${short(run[0]!)}–${short(run.at(-1)!)}`] : run.map(short))).join(', ');
}

/** The items no row on `rows` is yet, in the order given: a row is its task's whatever its draft text. */
export function notOnList(items: Recurring[], rows: Priority[]): Recurring[] {
  return items.filter((r) => !rows.some((p) => p.uid === r.uid));
}

/**
 * The items due on `date` (its ISO weekday is one of theirs), in the order given (the order they
 * were made, as Later's Repeats lists them), less those answered on this device today and those on
 * `rows` already (`notOnList`).
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
 * The list after Add to Today: each seed (the leftovers, then the tasks from Up Next) through
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
