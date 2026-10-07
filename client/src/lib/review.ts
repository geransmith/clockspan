import type { Day } from '../types';
import { addDays, addMonths, startOfQuarter, startOfWeek } from '../../../shared/dates.js';
import { breakSeconds } from './breaks';
import { formatDateSpan, formatMonth } from './format';
import { sameText } from '../../../shared/text.js';
import { focusOf, hasContent, reviewDay } from './retro';
import { dayTimeclock, daySettings, type TimeclockSettings } from './timeclock';

export const PERIOD_KINDS = ['week', 'month', 'quarter'] as const;
export type PeriodKind = (typeof PERIOD_KINDS)[number];

/** The period History → Review shows. */
export interface ReviewPeriod {
  kind: PeriodKind;
  /** The period's first day: a review left open past midnight stays on it. */
  from: string;
}

interface PeriodRange {
  from: string;
  to: string;
  label: string;
}

/**
 * The period `offset` steps back from the one holding `date`, so offset 0 is the period
 * holding it. Weeks run Monday to Sunday; quarters are calendar quarters.
 */
export function periodRange(kind: PeriodKind, date: string, offset: number): PeriodRange {
  if (kind === 'week') {
    const from = addDays(startOfWeek(date), -7 * offset);
    const to = addDays(from, 6);
    return { from, to, label: formatDateSpan(from, to) };
  }
  if (kind === 'month') {
    const from = addMonths(date, -offset);
    const to = addDays(addMonths(from, 1), -1);
    return { from, to, label: formatMonth(from) };
  }
  const from = addMonths(startOfQuarter(date), -3 * offset);
  const to = addDays(addMonths(from, 3), -1);
  const [y, m] = from.split('-').map(Number) as [number, number];
  return { from, to, label: `Q${Math.floor((m - 1) / 3) + 1} ${y}` };
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
  offPlanSeconds: number;
  /** The focused time that went to a priority, as a whole percent; null with no focus logged. */
  onPlanPercent: number | null;
  prioritiesDone: number;
  prioritiesTotal: number;
  retrosDone: number;
  /** Completed focus sessions. */
  sessions: number;
  /** The clocked-in days' own work-day lengths added up (`daySettings`): a month's or a quarter's target (`periodTarget`). */
  targetSeconds: number;
  /** Timer breaks, a running one so far. */
  breaks: { count: number; seconds: number };
  /** Rows added mid-day (`PriorityReview.addedMidDay`) and how many of them got ticked. */
  midDay: { added: number; done: number };
  /**
   * A typical day's rows written and ticked: the medians, each rounded half up, of the days
   * before today with a row written. Today is left out because it is still going; null with
   * fewer than two such days.
   */
  typicalDay: { planned: number; done: number } | null;
  /** Off-plan work by label, most time first: where the time went instead. */
  unplanned: UnplannedWork[];
  /** Priorities not ticked by the end of the range, the ones left open on the most days first, then by date. */
  notDone: OpenPriority[];
  /** Each day's "why", in date order. */
  notes: { date: string; note: string; reviewedAt: number | null }[];
}

/**
 * Roll a range of full days up into one review. Worked time comes from the same timeclock
 * math as the sheet, frozen for past days, and break time by the day log's math
 * (`breakSeconds`, a running break up to now); the plan and the focus reuse `reviewDay`. A day
 * after today is left out: all it can hold is a plan made the evening before (Plan tomorrow),
 * and none of it has happened yet. A day with nothing on it (`hasContent`) is left out too,
 * even with a break logged.
 */
export function reviewRange(days: Day[], settings: TimeclockSettings, today: string, now: number): RangeReview {
  const out: RangeReview = {
    days: 0,
    workedSeconds: 0,
    focusedSeconds: 0,
    offPlanSeconds: 0,
    onPlanPercent: null,
    prioritiesDone: 0,
    prioritiesTotal: 0,
    retrosDone: 0,
    sessions: 0,
    targetSeconds: 0,
    breaks: { count: 0, seconds: 0 },
    midDay: { added: 0, done: 0 },
    typicalDay: null,
    unplanned: [],
    notDone: [],
    notes: [],
  };
  const unplanned = new Map<string, UnplannedWork>();
  const notDone = new Map<string, OpenPriority>();
  // Rows written and ticked on each finished day with a plan, for the typical day.
  const plannedRows: number[] = [];
  const doneRows: number[] = [];
  let onPlan = 0;
  for (const day of days.filter((d) => d.date <= today).sort((a, b) => a.date.localeCompare(b.date))) {
    if (!hasContent(day)) continue;
    const tc = dayTimeclock(day, settings, today, now);
    const r = reviewDay(day.priorities, day.sessions);
    out.days++;
    out.workedSeconds += tc.workedSeconds;
    if (tc.clockIn != null) out.targetSeconds += daySettings(settings, day).workMinutes * 60;
    out.focusedSeconds += r.onPlanSeconds + r.offPlanSeconds;
    out.sessions += focusOf(day.sessions).count;
    onPlan += r.onPlanSeconds;
    out.offPlanSeconds += r.offPlanSeconds;
    out.prioritiesDone += r.done;
    out.prioritiesTotal += r.total;
    if (day.retroAt != null) out.retrosDone++;
    out.breaks.count += day.breaks.length;
    for (const b of day.breaks) out.breaks.seconds += breakSeconds(b, now);
    for (const p of r.planned) {
      if (!p.addedMidDay) continue;
      out.midDay.added++;
      if (p.priority.done) out.midDay.done++;
    }
    if (day.date < today && r.total > 0) {
      plannedRows.push(r.total);
      doneRows.push(r.done);
    }
    for (const session of r.unplanned) {
      const key = sameText(session.label);
      let g = unplanned.get(key);
      if (!g) unplanned.set(key, (g = { key, label: '', seconds: 0, dates: [] }));
      g.label = session.label.trim();
      g.seconds += session.durationSeconds;
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
  if (out.focusedSeconds > 0) out.onPlanPercent = Math.round((onPlan / out.focusedSeconds) * 100);
  // One planned day is that day, not a typical one.
  if (plannedRows.length > 1) out.typicalDay = { planned: median(plannedRows), done: median(doneRows) };
  out.unplanned = [...unplanned.values()].sort((a, b) => b.seconds - a.seconds || a.dates[0]!.localeCompare(b.dates[0]!));
  out.notDone = [...notDone.values()].sort((a, b) => b.dates.length - a.dates.length || a.dates[0]!.localeCompare(b.dates[0]!));
  return out;
}

/**
 * The hours a period is held to. A week takes the Work week setting, as the timeclock's week
 * line does; a month or a quarter, which no setting covers, adds up its clocked-in days' own
 * lengths (`RangeReview.targetSeconds`). 0 is no target.
 */
export function periodTarget(kind: PeriodKind, r: Pick<RangeReview, 'targetSeconds'>, weekMinutes: number): number {
  return kind === 'week' ? weekMinutes * 60 : r.targetSeconds;
}

/**
 * The middle of `values`, or halfway between the middle two rounded half up, so a typical day
 * is whole rows. With an odd count both indexes are the middle one.
 */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return Math.round((sorted[Math.floor((n - 1) / 2)]! + sorted[Math.floor(n / 2)]!) / 2);
}

/** Days are walked oldest first, so a new day is always the last one. */
function addDate(dates: string[], date: string): void {
  if (dates[dates.length - 1] !== date) dates.push(date);
}
