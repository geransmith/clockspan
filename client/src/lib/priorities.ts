import type { Day, Priority } from '../types';
import { hasText, isFree, sharesLink } from '../../../shared/priorities.js';
import { MAX_PRIORITIES } from '../../../shared/settings.js';
import { PRIORITY_WARNINGS } from './copy';

/** A row with text that isn't ticked: what the planner, the left-open offer and the timer's chips work from. */
export const isOpen = (p: Priority) => hasText(p) && !p.done;

/** A row the morning offer added from a recurring priority: it stays on today's list and never gets a board card. */
export const isRecurring = (p: Pick<Priority, 'recurringUid'>) => p.recurringUid != null;

/**
 * A one-off written on a list: a row with text and no recurring priority. A list with none has
 * no plan yet, so the left-open offer shows on it, and only these count toward the nudge.
 */
export const isOneOff = (p: Pick<Priority, 'text' | 'recurringUid'>) => hasText(p) && !isRecurring(p);

/** A row nothing was ever written in (`isFree`), linked to nothing: what the card pads a list with. */
export function emptyRow(position: number): Priority {
  return { position, text: '', done: false, uid: null, addedAt: null, cardUid: null, recurringUid: null, categoryUid: null };
}

/**
 * The stored list can be shorter than `count` (a day never edited, or one planned the evening
 * before) or hold empty rows the card saved. The card shows at least `count` rows and every
 * stored row beyond that, each with every field it was stored with.
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
 * Whether adding a row to `rows` asks first, and with which kind of warning: null while the rows
 * with text and no recurring priority are fewer than `warnThreshold(count)`. A cleared row, which a
 * new priority goes past, doesn't bring the warning on sooner, and neither do the routines, which
 * have their own number a day (`recurringPerDay`). The kind still counts every row with text, so
 * the warning starts from all the work ticked.
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
 * A row after an edit. An empty row can't be done, so clearing the text clears the tick. The
 * uid is minted (and `addedAt` stamped) the first time a row gets text and survives a clear,
 * so a session that pointed at the row still does; its links stay too. A cleared row is the
 * same item, and typing in it renames it.
 */
export function editPriority(row: Priority, patch: Partial<Priority>, now: number): Priority {
  const merged = { ...row, ...patch };
  if (!hasText(merged)) return { ...merged, done: false };
  return merged.uid ? merged : { ...merged, uid: newUid(), addedAt: now };
}

/** The rows without the one at `position`, renumbered from 1. */
export function removePriority(rows: Priority[], position: number): Priority[] {
  return rows.filter((p) => p.position !== position).map((p, i) => ({ ...p, position: i + 1 }));
}

/** Whether `placePriority` has somewhere to put a row: one never written in, or space for one more. */
export function hasRoom(rows: Priority[], count: number): boolean {
  const padded = padPriorities(rows, count);
  return padded.length < MAX_PRIORITIES || padded.some(isFree);
}

/**
 * `row` written into the cleared row that holds its card or recurring priority: the cleared
 * row's place, uid and `addedAt`, so the time logged on it counts again, and its category
 * unless `row` brings one (a cleared row keeps its category).
 */
export function takeBack(cleared: Priority, row: Omit<Priority, 'position'>): Priority {
  return { ...row, position: cleared.position, uid: cleared.uid, addedAt: cleared.addedAt, categoryUid: row.categoryUid ?? cleared.categoryUid };
}

/**
 * Where a row placed from outside the card goes (the timer's Also add, a board pull, the morning
 * offer's routines): the list as it is when a row with text already holds its non-null `cardUid`
 * or `recurringUid` (a repeat is a no-op); the cleared row that holds it (`takeBack`); else the
 * first row never written in (`isFree`), as `row` is; else a new row at the end. With `end` (the
 * morning offer) it goes after every row of the padded list instead, leaving the free rows for
 * one-offs, unless the list is at `MAX_PRIORITIES`, where a free row still takes it. Never another
 * cleared row: it keeps its uid, so writing over it would move its sessions onto the new priority.
 * A null link matches nothing. Returns the full list to save; null when the sheet is full.
 */
export function placePriority(rows: Priority[], count: number, row: Omit<Priority, 'position'>, opts: { end?: boolean } = {}): Priority[] | null {
  const padded = padPriorities(rows, count);
  if (padded.some((p) => hasText(p) && sharesLink(p, row))) return padded;
  const cleared = padded.find((p) => !hasText(p) && sharesLink(p, row));
  if (cleared) return padded.map((p) => (p === cleared ? takeBack(p, row) : p));
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
 * The latest day with a written one-off priority (no `recurringUid`), and its one-off rows that
 * were never ticked. A routine comes back on its own weekdays, so its rows are never carried, and
 * a day that held only routines isn't a plan. Null when no day had a plan, or the last one got
 * every one-off done: a finished plan has nothing to carry.
 */
export function leftOpen(days: Day[]): LeftOpen | null {
  let last: Day | null = null;
  for (const d of days) if (d.priorities.some(isOneOff) && (!last || d.date > last.date)) last = d;
  if (!last) return null;
  const rows = last.priorities.filter((p) => isOpen(p) && isOneOff(p));
  return rows.length ? { date: last.date, rows } : null;
}
