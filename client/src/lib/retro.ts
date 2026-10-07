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
