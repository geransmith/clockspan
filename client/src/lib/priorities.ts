import type { Day, Priority } from '../types';
import { hasText, isFree } from '../../../shared/priorities.js';
import { MAX_PRIORITIES } from '../../../shared/settings.js';
import { PRIORITY_WARNINGS } from './copy';

/** A row with text that isn't ticked: what the planner, the left-open offer and the timer's chips work from. */
export const isOpen = (p: Priority) => hasText(p) && !p.done;

/** A recurring priority's row: it stays on today's list and never goes in Later or Next. */
export const isRecurring = (p: Pick<Priority, 'recurring'>) => p.recurring;

/**
 * A one-off written on a list: a row with text that isn't a recurring priority's. A list with
 * none has no plan yet, so the left-open offer shows on it, and only these count toward the nudge.
 */
export const isOneOff = (p: Pick<Priority, 'text' | 'recurring'>) => hasText(p) && !p.recurring;

/** A free row (`isFree`): no task on it, which is what the card pads a list with. */
export function emptyRow(position: number): Priority {
  return { position, text: '', done: false, uid: null, addedAt: null, categoryUid: null, recurring: false, archived: false, listed: 0, earlier: 0, logged: 0 };
}

/**
 * The row for a task typed new, in `categoryUid`: a uid of its own, added `now`, on no other day
 * and with nothing logged on it. The save that first names the uid makes the task.
 */
export function newTaskRow(text: string, categoryUid: string | null, now: number): Omit<Priority, 'position'> & { uid: string } {
  return { text, done: false, uid: newUid(), addedAt: now, categoryUid, recurring: false, archived: false, listed: 0, earlier: 0, logged: 0 };
}

/**
 * The stored list can be shorter than `count` (a day never edited, or one planned the evening
 * before), and its positions can have gaps where free rows sat, since the server stores only
 * rows with a task. The card shows at least `count` rows and every stored row beyond that, each
 * at its place, with free rows in the gaps.
 */
export function padPriorities(rows: Priority[], count: number): Priority[] {
  const byPos = new Map(rows.map((r) => [r.position, r]));
  const n = Math.max(count, ...rows.map((r) => r.position));
  const out: Priority[] = [];
  for (let position = 1; position <= n; position++) {
    const r = byPos.get(position);
    out.push(r ? { ...r, position } : emptyRow(position));
  }
  return out;
}

/** Adding past this many rows gets a gentle warning first. */
export function warnThreshold(count: number): number {
  return Math.max(3, count);
}

/** Which pool the warning comes from: nothing ticked yet, some ticked, or all of them. */
export type WarningKind = 'fresh' | 'progress' | 'complete';

export function warningKind(done: number, total: number): WarningKind {
  if (done <= 0) return 'fresh';
  return done >= total ? 'complete' : 'progress';
}

/**
 * Whether adding a row to `rows` asks first, and with which kind of warning: null while the
 * one-off rows are fewer than `warnThreshold(count)`. The routines don't bring the warning on
 * sooner, since they have their own number a day (`recurringPerDay`). The kind still counts every
 * row with text, so the warning starts from all the work ticked.
 */
export function nudgeFor(rows: Priority[], count: number): WarningKind | null {
  if (rows.filter(isOneOff).length < warnThreshold(count)) return null;
  const written = rows.filter(hasText);
  return warningKind(written.filter((p) => p.done).length, written.length);
}

/** A random warning for the kind, never the same one twice in a row. */
export function pickWarning(kind: WarningKind, avoid?: string, rng: () => number = Math.random): string {
  const pool = PRIORITY_WARNINGS[kind].filter((w) => w !== avoid);
  return pool[Math.floor(rng() * pool.length)]!;
}

/**
 * Stable id for a priority so sessions can point at it after rows are renumbered. Twelve
 * hex chars from getRandomValues: randomUUID needs a secure context and a self-hosted
 * sheet on plain http isn't one.
 */
export function newUid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A row after an edit. The uid is minted (and `addedAt` stamped) the first time a free row gets
 * text: the task's, which the save that first names it makes. A row with a task keeps its uid and
 * its tick while its box is blank, since a blank name is never saved and comes back when the box
 * is left; a free row can't be done.
 */
export function editPriority(row: Priority, patch: Partial<Priority>, now: number): Priority {
  const merged = { ...row, ...patch };
  if (merged.uid) return merged;
  return hasText(merged) ? { ...merged, uid: newUid(), addedAt: now } : { ...merged, done: false };
}

/** The rows with the one at `position` a free row: × on a row within Rows per day takes its task off and leaves the row. */
export function clearRow(rows: Priority[], position: number): Priority[] {
  return rows.map((p) => (p.position === position ? emptyRow(position) : p));
}

/** The rows without the one at `position`, renumbered from 1. */
export function removePriority(rows: Priority[], position: number): Priority[] {
  return rows.filter((p) => p.position !== position).map((p, i) => ({ ...p, position: i + 1 }));
}

/** Whether `placePriority` has somewhere to put a row: a free row, or space for one more. */
export function hasRoom(rows: Priority[], count: number): boolean {
  const padded = padPriorities(rows, count);
  return padded.length < MAX_PRIORITIES || padded.some(isFree);
}

/**
 * Where a task placed from outside the card goes (the timer's Also add, a board pull, the morning
 * offer's routines): the list as it is when a row of the list is that task already (a repeat is a
 * no-op, whatever the row's draft text); else the first free row (`isFree`); else a new row at the
 * end. With `end` (the morning offer) it goes after every row of the padded list instead, leaving
 * the free rows for one-offs, unless the list is at `MAX_PRIORITIES`, where a free row still takes
 * it. Returns the full list to save; null when the sheet is full.
 */
export function placePriority(rows: Priority[], count: number, row: Omit<Priority, 'position'>, opts: { end?: boolean } = {}): Priority[] | null {
  const padded = padPriorities(rows, count);
  if (row.uid != null && padded.some((p) => p.uid === row.uid)) return padded;
  if (opts.end && padded.length < MAX_PRIORITIES) return [...padded, { ...row, position: padded.length + 1 }];
  const free = padded.find(isFree);
  if (free) return padded.map((p) => (p === free ? { ...row, position: p.position } : p));
  return padded.length < MAX_PRIORITIES ? [...padded, { ...row, position: padded.length + 1 }] : null;
}

/**
 * The unticked one-off rows of the last day that had a plan, offered on a new day's list while it
 * has no one-off written.
 */
export interface LeftOpen {
  date: string;
  rows: Priority[];
}

/**
 * The latest day with a one-off priority written, and its one-off rows that were never ticked. A
 * routine comes back on its own weekdays, so its rows are never carried, and a day that held only
 * routines isn't a plan. An archived one-off (a deleted card that `server/migrations/oneItem.ts`
 * kept for its rows) is never offered. Null when no day had a plan, or the last one has nothing
 * left to carry.
 */
export function leftOpen(days: Day[]): LeftOpen | null {
  let last: Day | null = null;
  for (const d of days) if (d.priorities.some(isOneOff) && (!last || d.date > last.date)) last = d;
  if (!last) return null;
  const rows = last.priorities.filter((p) => isOpen(p) && isOneOff(p) && !p.archived);
  return rows.length ? { date: last.date, rows } : null;
}
