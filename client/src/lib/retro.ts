import type { CompletedSession, Day, Priority, Session } from '../types';
import { hasText } from './priorities';

export interface PriorityReview {
  priority: Priority;
  /** Completed session time linked to this row. */
  focusedSeconds: number;
  sessions: number;
  /** Written after the day's first session started: it arrived mid-day, not in the plan. */
  addedMidDay: boolean;
}

export interface DayReview {
  /** Rows with text, in position order. */
  planned: PriorityReview[];
  /** Completed sessions not linked to a row (or linked to one that was removed). */
  unplanned: CompletedSession[];
  onPlanSeconds: number;
  offPlanSeconds: number;
  done: number;
  total: number;
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
  const rows = priorities.filter(hasText).sort((a, b) => a.position - b.position);
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

  return {
    planned,
    unplanned,
    onPlanSeconds,
    offPlanSeconds,
    done: rows.filter((p) => p.done).length,
    total: rows.length,
  };
}
