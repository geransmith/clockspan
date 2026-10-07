import type { Day, Priority } from '../types';
import { hasText, isFree } from '../../../shared/priorities.js';
import { MAX_PRIORITIES } from '../../../shared/settings.js';
import { PRIORITY_WARNINGS } from './copy';

/** A row with text that isn't ticked: what the planner, the left-open offer and the timer's chips work from. */
export const isOpen = (p: Priority) => hasText(p) && !p.done;

/**
 * The stored list can be shorter than `count` (a day never edited, or one planned the evening
 * before) or hold empty rows the card saved. The card shows at least `count` rows and every
 * stored row beyond that.
 */
export function padPriorities(rows: Priority[], count: number): Priority[] {
  const byPos = new Map(rows.map((r) => [r.position, r]));
  const n = Math.max(count, ...rows.map((r) => r.position));
  const out: Priority[] = [];
  for (let position = 1; position <= n; position++) {
    const r = byPos.get(position);
    out.push({ position, text: r?.text ?? '', done: r?.done ?? false, uid: r?.uid ?? null, addedAt: r?.addedAt ?? null });
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
 * Whether adding a row to `rows` asks first, and with which kind of warning: null below
 * `warnThreshold(count)`. Only rows with text count, so a cleared row, which a new priority
 * goes past, doesn't bring the warning on sooner.
 */
export function nudgeFor(rows: Priority[], count: number): WarningKind | null {
  const written = rows.filter(hasText);
  if (written.length < warnThreshold(count)) return null;
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
 * so a session that pointed at the row still does.
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
 * Where a priority added from the timer goes: the first row never written in (`isFree`), else a
 * new row at the end. Never a cleared row: it keeps its uid, so writing over it would move its
 * sessions onto the new priority. Returns the full list to save; null when the sheet is full.
 */
export function placePriority(rows: Priority[], count: number, text: string, uid: string, addedAt: number): Priority[] | null {
  const padded = padPriorities(rows, count);
  const row = { text, done: false, uid, addedAt };
  const free = padded.find(isFree);
  if (free) return padded.map((p) => (p === free ? { ...p, ...row } : p));
  return padded.length < MAX_PRIORITIES ? [...padded, { position: padded.length + 1, ...row }] : null;
}

/** The unticked rows of the last day that had a plan, offered on a new day's empty list. */
export interface LeftOpen {
  date: string;
  rows: Priority[];
}

/**
 * The latest day with a written priority, and its rows that were never ticked. Null when no
 * day had a plan, or the last one got everything done: a finished plan has nothing to carry.
 */
export function leftOpen(days: Day[]): LeftOpen | null {
  let last: Day | null = null;
  for (const d of days) if (d.priorities.some(hasText) && (!last || d.date > last.date)) last = d;
  if (!last) return null;
  const rows = last.priorities.filter(isOpen);
  return rows.length ? { date: last.date, rows } : null;
}
