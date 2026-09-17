import type { Priority, Session } from '../types';

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
  unplanned: Session[];
  onPlanSeconds: number;
  offPlanSeconds: number;
  done: number;
  total: number;
}

/**
 * Pure plan-vs-actual for one day. Only completed sessions count; a running one isn't
 * done yet. A session is on plan when its uid matches a row that still has text.
 */
export function reviewDay(priorities: Priority[], sessions: Session[]): DayReview {
  const rows = priorities.filter((p) => p.text.trim()).sort((a, b) => a.position - b.position);
  const completed = sessions.filter((s) => s.status === 'completed');
  const firstStart = completed.length ? Math.min(...completed.map((s) => s.startedAt)) : null;
  const byUid = new Map(rows.filter((p) => p.uid).map((p) => [p.uid!, p]));

  const focused = new Map<string, { seconds: number; count: number }>();
  const unplanned: Session[] = [];
  let onPlanSeconds = 0;
  let offPlanSeconds = 0;
  for (const s of completed) {
    const seconds = s.durationSeconds ?? 0;
    if (s.priorityUid && byUid.has(s.priorityUid)) {
      const cur = focused.get(s.priorityUid) ?? { seconds: 0, count: 0 };
      focused.set(s.priorityUid, { seconds: cur.seconds + seconds, count: cur.count + 1 });
      onPlanSeconds += seconds;
    } else {
      unplanned.push(s);
      offPlanSeconds += seconds;
    }
  }

  const planned = rows.map((priority) => {
    const f = priority.uid ? focused.get(priority.uid) : undefined;
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
