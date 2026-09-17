import type { Day, Session, Settings } from '../types';
import { addDays, addMonths, endOfDay, formatDateSpan, formatMonth, parseDateKey, startOfMonth, startOfQuarter, startOfWeek } from './format';
import { reviewDay } from './retro';
import { computeTimeclock } from './timeclock';

export type PeriodKind = 'week' | 'month' | 'quarter';

export interface Period {
  kind: PeriodKind;
  from: string;
  to: string;
  label: string;
}

/**
 * The period `offset` steps back from the one containing `today` (0 = current). Weeks run
 * Monday to Sunday; quarters are calendar quarters.
 */
export function periodRange(kind: PeriodKind, today: string, offset: number): Period {
  if (kind === 'week') {
    const from = addDays(startOfWeek(today), -7 * offset);
    const to = addDays(from, 6);
    return { kind, from, to, label: formatDateSpan(from, to) };
  }
  if (kind === 'month') {
    const from = addMonths(startOfMonth(today), -offset);
    const to = addDays(addMonths(from, 1), -1);
    return { kind, from, to, label: formatMonth(from) };
  }
  const from = addMonths(startOfQuarter(today), -3 * offset);
  const to = addDays(addMonths(from, 3), -1);
  const [y, m] = from.split('-').map(Number) as [number, number];
  return { kind, from, to, label: `Q${Math.floor((m - 1) / 3) + 1} ${y}` };
}

/**
 * The `offset` that makes `periodRange` land on the period holding `date`: 0 for today's
 * period and for any future date (the review never steps forward). The calendar opens on
 * the month of the day being viewed, and "Review this week" jumps to a past week with it.
 */
export function periodOffset(kind: PeriodKind, today: string, date: string): number {
  if (date >= today) return 0;
  if (kind === 'week') {
    // Whole weeks between the two Mondays; rounding absorbs a DST hour.
    const ms = parseDateKey(startOfWeek(today)).getTime() - parseDateKey(startOfWeek(date)).getTime();
    return Math.max(0, Math.round(ms / (7 * 86_400_000)));
  }
  const [ty, tm] = today.split('-').map(Number) as [number, number];
  const [dy, dm] = date.split('-').map(Number) as [number, number];
  if (kind === 'month') return Math.max(0, (ty - dy) * 12 + (tm - dm));
  return Math.max(0, (ty - dy) * 4 + Math.floor((tm - 1) / 3) - Math.floor((dm - 1) / 3));
}

export interface UnplannedWork {
  date: string;
  session: Session;
}

export interface UndoneGoal {
  date: string;
  text: string;
  focusedSeconds: number;
  addedMidDay: boolean;
}

export interface RangeReview {
  /** Days in the range that have anything on them. */
  days: number;
  workedSeconds: number;
  focusedSeconds: number;
  onPlanSeconds: number;
  offPlanSeconds: number;
  prioritiesDone: number;
  prioritiesTotal: number;
  retrosDone: number;
  /** Sessions that weren't for a priority, longest first: where the time went instead. */
  unplanned: UnplannedWork[];
  /** Priorities never ticked, in date order. */
  notDone: UndoneGoal[];
  /** Each day's "why", in date order. */
  notes: { date: string; note: string; reviewedAt: number | null }[];
}

type TcSettings = Pick<Settings, 'workMinutes' | 'lunchDeadlineMinutes' | 'lunchMinutes' | 'secondMealAfterMinutes'>;

/**
 * Roll a range of full days up into one review. Worked time comes from the same timeclock
 * math as the sheet, frozen for past days; everything else reuses `reviewDay`.
 */
export function reviewRange(days: Day[], settings: TcSettings, today: string, now: number): RangeReview {
  const out: RangeReview = {
    days: 0,
    workedSeconds: 0,
    focusedSeconds: 0,
    onPlanSeconds: 0,
    offPlanSeconds: 0,
    prioritiesDone: 0,
    prioritiesTotal: 0,
    retrosDone: 0,
    unplanned: [],
    notDone: [],
    notes: [],
  };
  for (const day of [...days].sort((a, b) => a.date.localeCompare(b.date))) {
    const isToday = day.date === today;
    const tc = computeTimeclock(day.punches, settings, isToday ? now : Math.min(now, endOfDay(day.date)), { frozen: !isToday });
    const r = reviewDay(day.priorities, day.sessions);
    const hasSomething = tc.clockIn != null || r.total > 0 || r.unplanned.length > 0 || r.onPlanSeconds > 0 || day.retroNote.trim() !== '';
    if (!hasSomething) continue;
    out.days++;
    out.workedSeconds += tc.clockIn != null ? tc.workedSeconds : 0;
    out.focusedSeconds += r.onPlanSeconds + r.offPlanSeconds;
    out.onPlanSeconds += r.onPlanSeconds;
    out.offPlanSeconds += r.offPlanSeconds;
    out.prioritiesDone += r.done;
    out.prioritiesTotal += r.total;
    if (day.retroAt != null) out.retrosDone++;
    for (const session of r.unplanned) out.unplanned.push({ date: day.date, session });
    for (const p of r.planned) {
      if (!p.priority.done) out.notDone.push({ date: day.date, text: p.priority.text, focusedSeconds: p.focusedSeconds, addedMidDay: p.addedMidDay });
    }
    if (day.retroNote.trim()) out.notes.push({ date: day.date, note: day.retroNote, reviewedAt: day.retroAt });
  }
  out.unplanned.sort((a, b) => (b.session.durationSeconds ?? 0) - (a.session.durationSeconds ?? 0) || a.date.localeCompare(b.date));
  return out;
}
