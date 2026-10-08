import type { SessionEdit } from '../api';
import type { CompletedSession, Day, Priority, Session } from '../types';
import { hasText } from '../../../shared/priorities.js';

export interface PriorityReview {
  priority: Priority;
  /** Completed session time linked to this row. */
  focusedSeconds: number;
  sessions: number;
  /** Written after the day's first completed session started: it arrived mid-day, not in the plan. */
  addedMidDay: boolean;
}

export interface DayReview {
  /** Rows with text, in position order. */
  planned: PriorityReview[];
  /** Completed sessions not linked to a row with text (unlinked, or linked to a row since removed or emptied). */
  unplanned: CompletedSession[];
  onPlanSeconds: number;
  offPlanSeconds: number;
  done: number;
  total: number;
  /** The rows added from a recurring priority (`recurringUid`), which `done` and `total` count too. */
  routines: { done: number; total: number };
}

/**
 * A day's focus: its completed sessions' logged time and how many there were. A running or
 * cancelled session counts for neither.
 */
export function focusOf(sessions: Session[]): { seconds: number; count: number } {
  let seconds = 0;
  let count = 0;
  for (const s of sessions) {
    if (s.status !== 'completed') continue;
    seconds += s.durationSeconds;
    count++;
  }
  return { seconds, count };
}

/**
 * Completed focus by the row it was logged against: seconds per `priorityUid`. A running or
 * cancelled session, or one on no row, adds nothing.
 */
export function loggedByUid(sessions: Session[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of sessions) {
    if (s.status !== 'completed' || s.priorityUid == null) continue;
    out.set(s.priorityUid, (out.get(s.priorityUid) ?? 0) + s.durationSeconds);
  }
  return out;
}

/** The row of its day that a session's `priorityUid` names, while that row is on the list. */
function namedRow(s: Session, rows: Priority[]): Priority | undefined {
  return s.priorityUid == null ? undefined : rows.find((p) => p.uid === s.priorityUid);
}

/**
 * The category a session counts under, given the rows of its own day. A session on a written
 * row counts under that row's category, none included, so retagging the row moves its time.
 * Off a written row, the session's own category decides: one picked in the log, or the one the
 * server copied from its row when a save removed it. Failing that, an emptied row it still names
 * keeps the time under that row's category. Else none.
 */
export function sessionCategory(s: Session, rows: Priority[]): string | null {
  const row = namedRow(s, rows);
  if (row && hasText(row)) return row.categoryUid;
  return s.categoryUid ?? row?.categoryUid ?? null;
}

/**
 * The day log's edit that makes a session on no written row count under `categoryUid`
 * (`sessionCategory`). A category is set as the session's own, which outranks an emptied row it
 * names. None can't be stored that way, since no category of its own means "go by that row": a
 * session on an emptied row that has a category leaves the row as well (`priorityUid: null`).
 * The log already shows it as unplanned; the row's note about the time kept on it stops
 * counting it.
 */
export function sessionCategoryEdit(s: Session, rows: Priority[], categoryUid: string | null): Pick<SessionEdit, 'categoryUid' | 'priorityUid'> {
  const row = namedRow(s, rows);
  return categoryUid == null && row != null && !hasText(row) && row.categoryUid != null ? { categoryUid, priorityUid: null } : { categoryUid };
}

/**
 * The day log's edit that links a session to a written row, or to none. Linked, the row decides
 * its category, so a category of its own goes: kept, it would outrank the row's once the row was
 * emptied, and the server copies a removed row's category only onto sessions that have none.
 */
export function sessionLinkEdit(s: Session, priorityUid: string | null): Pick<SessionEdit, 'categoryUid' | 'priorityUid'> {
  return priorityUid != null && s.categoryUid != null ? { priorityUid, categoryUid: null } : { priorityUid };
}

/**
 * Whether a day has anything on it: a punch, a row with text, a completed session, a note or a
 * review. The calendar's cells and the review's day count both go by it; a padded empty row, a
 * running session and a day's own work-day length don't count.
 */
export function hasContent(day: Day): boolean {
  return (
    day.punches.some((p) => p.at != null) ||
    day.priorities.some(hasText) ||
    day.sessions.some((s) => s.status === 'completed') ||
    day.retroNote.trim() !== '' ||
    day.retroAt != null
  );
}

/**
 * Pure plan-vs-actual for one day. Only completed sessions count; a running one isn't
 * done yet. A session is on plan when its uid matches a row that still has text.
 */
export function reviewDay(priorities: Priority[], sessions: Session[]): DayReview {
  const rows = priorities.filter(hasText);
  const completed = sessions.filter((s) => s.status === 'completed');
  const firstStart = completed.length ? Math.min(...completed.map((s) => s.startedAt)) : null;
  const uids = new Set(rows.map((p) => p.uid));

  const focused = new Map<string | null, { seconds: number; count: number }>();
  const unplanned: CompletedSession[] = [];
  let onPlanSeconds = 0;
  let offPlanSeconds = 0;
  for (const s of completed) {
    const seconds = s.durationSeconds;
    if (s.priorityUid && uids.has(s.priorityUid)) {
      const cur = focused.get(s.priorityUid) ?? { seconds: 0, count: 0 };
      focused.set(s.priorityUid, { seconds: cur.seconds + seconds, count: cur.count + 1 });
      onPlanSeconds += seconds;
    } else {
      unplanned.push(s);
      offPlanSeconds += seconds;
    }
  }

  const planned = rows.map((priority) => {
    const f = focused.get(priority.uid);
    return {
      priority,
      focusedSeconds: f?.seconds ?? 0,
      sessions: f?.count ?? 0,
      addedMidDay: firstStart != null && priority.addedAt != null && priority.addedAt > firstStart,
    };
  });

  const routines = rows.filter((p) => p.recurringUid != null);
  return {
    planned,
    unplanned,
    onPlanSeconds,
    offPlanSeconds,
    done: rows.filter((p) => p.done).length,
    total: rows.length,
    routines: { done: routines.filter((p) => p.done).length, total: routines.length },
  };
}
