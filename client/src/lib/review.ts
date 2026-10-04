import type { Day } from '../types';
import { addDays, addMonths, DAY_MS, parseDateKey, startOfMonth, startOfQuarter, startOfWeek } from '../../../shared/dates.js';
import { formatDateSpan, formatMonth, sameText } from './format';
import { hasContent, reviewDay } from './retro';
import { dayTimeclock, type TimeclockSettings } from './timeclock';

export const PERIOD_KINDS = ['week', 'month', 'quarter'] as const;
export type PeriodKind = (typeof PERIOD_KINDS)[number];

/** The period History → Review shows. */
export interface ReviewPeriod {
  kind: PeriodKind;
  /** The period's first day: a review left open past midnight stays on it. */
  from: string;
}

export interface Period {
  kind: PeriodKind;
  from: string;
  to: string;
  label: string;
}

/**
 * The period `offset` steps back from the one holding `date`, so offset 0 is the period
 * holding it. Weeks run Monday to Sunday; quarters are calendar quarters.
 */
export function periodRange(kind: PeriodKind, date: string, offset: number): Period {
  if (kind === 'week') {
    const from = addDays(startOfWeek(date), -7 * offset);
    const to = addDays(from, 6);
    return { kind, from, to, label: formatDateSpan(from, to) };
  }
  if (kind === 'month') {
    const from = addMonths(startOfMonth(date), -offset);
    const to = addDays(addMonths(from, 1), -1);
    return { kind, from, to, label: formatMonth(from) };
  }
  const from = addMonths(startOfQuarter(date), -3 * offset);
  const to = addDays(addMonths(from, 3), -1);
  const [y, m] = from.split('-').map(Number) as [number, number];
  return { kind, from, to, label: `Q${Math.floor((m - 1) / 3) + 1} ${y}` };
}

/**
 * How many periods back from today's the period holding `date` is: what PeriodNav steps and
 * resets a held period by. 0 for the current period and for any future date (the review never
 * steps forward).
 */
export function periodOffset(kind: PeriodKind, today: string, date: string): number {
  if (date >= today) return 0;
  if (kind === 'week') {
    // Whole weeks between the two Mondays; rounding absorbs a DST hour.
    const ms = parseDateKey(startOfWeek(today)).getTime() - parseDateKey(startOfWeek(date)).getTime();
    return Math.max(0, Math.round(ms / (7 * DAY_MS)));
  }
  const [ty, tm] = today.split('-').map(Number) as [number, number];
  const [dy, dm] = date.split('-').map(Number) as [number, number];
  if (kind === 'month') return Math.max(0, (ty - dy) * 12 + (tm - dm));
  return Math.max(0, (ty - dy) * 4 + Math.floor((tm - 1) / 3) - Math.floor((dm - 1) / 3));
}

/**
 * Sessions that weren't for a priority, merged by label (ignoring case and spacing) so a
 * chore that keeps coming back reads as one row with its total. `label` is the latest
 * spelling, '' for untitled sessions.
 */
export interface UnplannedWork {
  key: string;
  label: string;
  seconds: number;
  sessions: number;
  /** The distinct days it happened on, oldest first. */
  dates: string[];
}

/** A priority not ticked by the end of the range, merged across the days it was left open the same way. */
export interface OpenPriority {
  key: string;
  text: string;
  /** The distinct days it was left open on since it was last ticked, oldest first. */
  dates: string[];
  focusedSeconds: number;
  /** Added mid-day on any of those days. */
  addedMidDay: boolean;
}

export interface RangeReview {
  /** Days in the range, up to today, that have anything on them (`hasContent`). */
  days: number;
  workedSeconds: number;
  focusedSeconds: number;
  onPlanSeconds: number;
  offPlanSeconds: number;
  /** The focused time that went to a priority, as a whole percent; null with no focus logged. */
  onPlanPercent: number | null;
  prioritiesDone: number;
  prioritiesTotal: number;
  retrosDone: number;
  /** Off-plan work by label, most time first: where the time went instead. */
  unplanned: UnplannedWork[];
  /** Priorities not ticked by the end of the range, the ones left open on the most days first, then by date. */
  notDone: OpenPriority[];
  /** Each day's "why", in date order. */
  notes: { date: string; note: string; reviewedAt: number | null }[];
}

/**
 * Roll a range of full days up into one review. Worked time comes from the same timeclock
 * math as the sheet, frozen for past days; everything else reuses `reviewDay`. A day after
 * today is left out: all it can hold is a plan made the evening before (Plan tomorrow), and
 * none of it has happened yet.
 */
export function reviewRange(days: Day[], settings: TimeclockSettings, today: string, now: number): RangeReview {
  const out: RangeReview = {
    days: 0,
    workedSeconds: 0,
    focusedSeconds: 0,
    onPlanSeconds: 0,
    offPlanSeconds: 0,
    onPlanPercent: null,
    prioritiesDone: 0,
    prioritiesTotal: 0,
    retrosDone: 0,
    unplanned: [],
    notDone: [],
    notes: [],
  };
  const unplanned = new Map<string, UnplannedWork>();
  const notDone = new Map<string, OpenPriority>();
  for (const day of days.filter((d) => d.date <= today).sort((a, b) => a.date.localeCompare(b.date))) {
    if (!hasContent(day)) continue;
    const tc = dayTimeclock(day, settings, today, now);
    const r = reviewDay(day.priorities, day.sessions);
    out.days++;
    out.workedSeconds += tc.workedSeconds;
    out.focusedSeconds += r.onPlanSeconds + r.offPlanSeconds;
    out.onPlanSeconds += r.onPlanSeconds;
    out.offPlanSeconds += r.offPlanSeconds;
    out.prioritiesDone += r.done;
    out.prioritiesTotal += r.total;
    if (day.retroAt != null) out.retrosDone++;
    for (const session of r.unplanned) {
      const key = sameText(session.label);
      let g = unplanned.get(key);
      if (!g) unplanned.set(key, (g = { key, label: '', seconds: 0, sessions: 0, dates: [] }));
      g.label = session.label.trim();
      g.seconds += session.durationSeconds;
      g.sessions++;
      addDate(g.dates, day.date);
    }
    // A tick settles the priority: the same text left open on an earlier day is done now.
    const ticked = new Set(r.planned.filter((p) => p.priority.done).map((p) => sameText(p.priority.text)));
    for (const key of ticked) notDone.delete(key);
    for (const p of r.planned) {
      const key = sameText(p.priority.text);
      if (ticked.has(key)) continue;
      let g = notDone.get(key);
      if (!g) notDone.set(key, (g = { key, text: '', dates: [], focusedSeconds: 0, addedMidDay: false }));
      g.text = p.priority.text.trim();
      g.focusedSeconds += p.focusedSeconds;
      g.addedMidDay ||= p.addedMidDay;
      addDate(g.dates, day.date);
    }
    const note = day.retroNote.trim();
    if (note) out.notes.push({ date: day.date, note, reviewedAt: day.retroAt });
  }
  if (out.focusedSeconds > 0) out.onPlanPercent = Math.round((out.onPlanSeconds / out.focusedSeconds) * 100);
  out.unplanned = [...unplanned.values()].sort((a, b) => b.seconds - a.seconds || a.dates[0]!.localeCompare(b.dates[0]!));
  out.notDone = [...notDone.values()].sort((a, b) => b.dates.length - a.dates.length || a.dates[0]!.localeCompare(b.dates[0]!));
  return out;
}

/** Days are walked oldest first, so a new day is always the last one. */
function addDate(dates: string[], date: string): void {
  if (dates[dates.length - 1] !== date) dates.push(date);
}
