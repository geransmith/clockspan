import type { SessionEdit } from '../api';
import type { CompletedSession, Day, Priority, Session } from '../types';
import { hasText } from '../../../shared/priorities.js';
import { activeMs } from '../../../shared/timer.js';

export interface PriorityReview {
  priority: Priority;
  /** Completed session time on this row's task, that day. */
  focusedSeconds: number;
  sessions: number;
  /** Put on the day's list after the day's first completed session started: it arrived mid-day, not in the plan. */
  addedMidDay: boolean;
}

export interface DayReview {
  /** Rows with text, in position order. */
  planned: PriorityReview[];
  /** Completed sessions whose task isn't on the day's list, or that have none. */
  unplanned: CompletedSession[];
  onPlanSeconds: number;
  offPlanSeconds: number;
  done: number;
  total: number;
  /** The recurring priorities' rows (`recurring`), which `done` and `total` count too. */
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
 * Focus by the task it was logged on, at `now`: seconds per `priorityUid`, a running session's so
 * far included. A running one counts a second at least, so a timer that just started (or a clock
 * behind the server's) still counts as time on its task. A cancelled session, or one on no task,
 * adds nothing.
 */
export function loggedByUid(sessions: Session[], now: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of sessions) {
    if (s.status === 'cancelled' || s.priorityUid == null) continue;
    const seconds = s.status === 'completed' ? s.durationSeconds : Math.max(1, activeMs(s, now) / 1000);
    out.set(s.priorityUid, (out.get(s.priorityUid) ?? 0) + seconds);
  }
  return out;
}

/** The written row of its day a session's task is, while the day's list holds it. */
export function sessionRow(s: Session, rows: Priority[]): Priority | undefined {
  const row = s.priorityUid == null ? undefined : rows.find((p) => p.uid === s.priorityUid);
  return row && hasText(row) ? row : undefined;
}

/**
 * What a session is called, given the rows of its own day: its task's current name, which is its
 * row's text while the day's list holds it (so a rename on the sheet shows at once), else the
 * name the server gave (`title`), once the task has left that day. A session with no task is
 * called by its label.
 */
export function sessionName(s: Session, rows: Priority[]): string {
  return sessionRow(s, rows)?.text.trim() ?? s.title ?? s.label;
}

/**
 * The category a session counts under, given the rows of its own day: its row's while the day's
 * list holds its task, so a chip changed on the sheet shows at once, none included; else the one
 * the server gave, which is its task's, or for a session with no task one picked in the log or
 * kept from the task it lost.
 */
export function sessionCategory(s: Session, rows: Priority[]): string | null {
  const row = sessionRow(s, rows);
  return row ? row.categoryUid : s.categoryUid;
}

/**
 * The day log's edit that makes a session off the plan count under `categoryUid`, none included.
 * A session with a task counts under the task's category, so one whose task left its day leaves
 * the task too (`priorityUid: null`): picking a category for that time says what it was for.
 */
export function sessionCategoryEdit(s: Session, categoryUid: string | null): Pick<SessionEdit, 'categoryUid' | 'priorityUid'> {
  return s.priorityUid == null ? { categoryUid } : { categoryUid, priorityUid: null };
}

/**
 * A session with an edit laid on, as the server will store it, for the day store and the timer to
 * show while the edit is out. Linked to another task, it loses a category of its own and is named
 * and filed by that task's row until the answer brings the task's. Taken off its task, it keeps
 * the task's name as its label unless the edit names it, and counts under the category sent, else
 * none.
 */
export function editedSession(s: Session, patch: SessionEdit): Session {
  const next = { ...s, ...patch };
  if (patch.priorityUid === undefined || patch.priorityUid === s.priorityUid) return next;
  if (patch.priorityUid != null) return { ...next, title: null, categoryUid: null };
  return { ...next, title: null, label: patch.label ?? s.title ?? s.label, categoryUid: patch.categoryUid ?? null };
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
 * done yet. A session is on plan when the day's list holds its task.
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

  const routines = rows.filter((p) => p.recurring);
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
