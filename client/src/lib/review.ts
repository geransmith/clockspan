import type { Day, Priority } from '../types';
import { LOOKBACK_DAYS } from '../../../shared/api.js';
import { addDays, addMonths, startOfQuarter, startOfWeek } from '../../../shared/dates.js';
import { breakSeconds } from './breaks';
import { formatDateSpan, formatMonth } from './format';
import { sameText } from '../../../shared/text.js';
import { focusOf, hasContent, reviewDay, sessionCategory, sessionName, type PriorityReview } from './retro';
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
 * Time off the plan: a task's sessions on days whose list didn't hold it, as one row under the
 * task's name, and the sessions with no task merged by label (ignoring case and spacing), so a
 * chore that keeps coming back reads as one row with its total.
 */
export interface UnplannedWork {
  /** `task:<uid>`, or `label:<sameText>` for sessions with no task. */
  key: string;
  /** The task's current name, or the label's latest spelling; '' for untitled sessions. */
  label: string;
  seconds: number;
  /** The distinct days it happened on, oldest first. */
  dates: string[];
}

/**
 * A recurring priority's rows across the range: the days it was on the list and how many of them
 * it got ticked. Each day stands on its own, so a tick doesn't settle an earlier miss, and none of
 * its rows is a task left open in Not done.
 */
export interface RoutineReview {
  uid: string;
  /** Its current name, which every row of it shows. */
  title: string;
  /** The days a row linked to it had text, oldest first; the row opens the latest. */
  dates: string[];
  /** The days it was ticked on. */
  done: number;
  focusedSeconds: number;
}

/**
 * The range's focus and ticks under one category: each row's under its task's category, and each
 * session off the plan under `sessionCategory`, so a task's time on a day that didn't list it
 * still counts under the task's category.
 */
export interface CategoryTime {
  /** A category the board knows (`known`); null for none, or one it doesn't know. */
  categoryUid: string | null;
  /** Completed focus under it, on plan and off. */
  seconds: number;
  /** The part not for a written row. */
  offPlanSeconds: number;
  /** Priorities ticked under it. */
  done: number;
}

/** A task not ticked by the end of the range: a one-off's days left open, with a retyped task joined by its text (`addToNotDone`). */
export interface OpenPriority {
  /** The uid of the task that opened it. */
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
  /**
   * Rows added mid-day (`PriorityReview.addedMidDay`), how many of them got ticked, and the
   * category more than half of them had, if one did (a plurality short of half names none).
   */
  midDay: { added: number; done: number; categoryUid: string | null };
  /**
   * A typical day's rows written and ticked: the medians, each rounded half up, of the days
   * before today with a row written. Today is left out because it is still going; null with
   * fewer than two such days.
   */
  typicalDay: { planned: number; done: number } | null;
  /**
   * The focus and the ticks by category, most time first, then the most ticks, and no category
   * last. A category with neither is left out; the sums are `focusedSeconds`, `offPlanSeconds`
   * and `prioritiesDone`.
   */
  byCategory: CategoryTime[];
  /** Off-plan work by task, else by label, most time first: where the time went instead. */
  unplanned: UnplannedWork[];
  /** The recurring priorities on the range's lists: on the most days first, then the most focus, then by title. */
  routines: RoutineReview[];
  /** One-offs not ticked by the end of the range, the ones left open on the most days first, then by date. A routine's rows are in `routines`. */
  notDone: OpenPriority[];
  /** Each day's "why", in date order. */
  notes: { date: string; note: string; reviewedAt: number | null }[];
}

/**
 * Roll a range of full days up into one review. Worked time comes from the same timeclock
 * math as the sheet, frozen for past days, with a day whose punches are out of order left out of
 * it and of `targetSeconds`, and break time by the day log's math
 * (`breakSeconds`, a running break up to now); the plan and the focus reuse `reviewDay`. A day
 * after today is left out: none of it has happened yet. A day with nothing on it (`hasContent`)
 * is left out too, even with a break logged. A recurring priority's rows count as priorities in
 * every total and go to `routines` rather than Not done. `known` is the uids of the board's
 * categories, removed ones included: a category outside it (none before the board's first read)
 * counts as none, in `byCategory` and in `midDay`. `laned` is the uids of the tasks the board
 * holds in Later or Next, which Not done never joins to another task by its text.
 */
export function reviewRange(
  days: Day[],
  settings: TimeclockSettings,
  today: string,
  now: number,
  known: ReadonlySet<string> = new Set(),
  laned: ReadonlySet<string> = new Set(),
): RangeReview {
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
    midDay: { added: 0, done: 0, categoryUid: null },
    typicalDay: null,
    byCategory: [],
    unplanned: [],
    routines: [],
    notDone: [],
    notes: [],
  };
  const unplanned = new Map<string, UnplannedWork>();
  const routines = new Map<string, RoutineReview>();
  const notDone = new Map<string, OpenPriority>();
  // Each one-off task's group in Not done, by its uid: its own, or the one its text joined.
  const groupOf = new Map<string, string>();
  // Met first, first in the map: the sort keeps that order on a tie.
  const byCategory = new Map<string | null, CategoryTime>();
  const midDayCategories = new Map<string, number>();
  const knownOrNone = (uid: string | null) => (uid != null && known.has(uid) ? uid : null);
  const categoryTime = (uid: string | null): CategoryTime => {
    const categoryUid = knownOrNone(uid);
    let c = byCategory.get(categoryUid);
    if (!c) byCategory.set(categoryUid, (c = { categoryUid, seconds: 0, offPlanSeconds: 0, done: 0 }));
    return c;
  };
  // Rows written and ticked on each finished day with a plan, for the typical day.
  const plannedRows: number[] = [];
  const doneRows: number[] = [];
  let onPlan = 0;
  for (const day of days.filter((d) => d.date <= today).sort((a, b) => a.date.localeCompare(b.date))) {
    if (!hasContent(day)) continue;
    const tc = dayTimeclock(day, settings, today, now);
    const r = reviewDay(day.priorities, day.sessions);
    out.days++;
    // A day with punches out of order has no worked time to trust (its sheet shows a dash), so it
    // is left out of the hours and of the target they are held to.
    if (!tc.outOfOrder) {
      out.workedSeconds += tc.workedSeconds;
      if (tc.clockIn != null) out.targetSeconds += daySettings(settings, day).workMinutes * 60;
    }
    out.focusedSeconds += r.onPlanSeconds + r.offPlanSeconds;
    out.sessions += focusOf(day.sessions).count;
    onPlan += r.onPlanSeconds;
    out.offPlanSeconds += r.offPlanSeconds;
    out.prioritiesDone += r.done;
    out.prioritiesTotal += r.total;
    if (day.retroAt != null) out.retrosDone++;
    out.breaks.count += day.breaks.length;
    for (const b of day.breaks) out.breaks.seconds += breakSeconds(b, now);
    const oneOffs: PriorityReview[] = [];
    for (const p of r.planned) {
      const c = categoryTime(p.priority.categoryUid);
      c.seconds += p.focusedSeconds;
      if (p.priority.done) c.done++;
      if (p.addedMidDay) {
        out.midDay.added++;
        if (p.priority.done) out.midDay.done++;
        const category = knownOrNone(p.priority.categoryUid);
        if (category != null) midDayCategories.set(category, (midDayCategories.get(category) ?? 0) + 1);
      }
      if (!p.priority.recurring) {
        oneOffs.push(p);
        continue;
      }
      const uid = p.priority.uid!;
      let g = routines.get(uid);
      if (!g) routines.set(uid, (g = { uid, title: '', dates: [], done: 0, focusedSeconds: 0 }));
      g.title = p.priority.text.trim();
      addDate(g.dates, day.date);
      if (p.priority.done) g.done++;
      g.focusedSeconds += p.focusedSeconds;
    }
    if (day.date < today && r.total > 0) {
      plannedRows.push(r.total);
      doneRows.push(r.done);
    }
    for (const session of r.unplanned) {
      const key = session.priorityUid != null ? `task:${session.priorityUid}` : `label:${sameText(session.label)}`;
      let g = unplanned.get(key);
      if (!g) unplanned.set(key, (g = { key, label: '', seconds: 0, dates: [] }));
      g.label = sessionName(session, day.priorities).trim();
      g.seconds += session.durationSeconds;
      addDate(g.dates, day.date);
      const c = categoryTime(sessionCategory(session, day.priorities));
      c.seconds += session.durationSeconds;
      c.offPlanSeconds += session.durationSeconds;
    }
    addToNotDone(notDone, groupOf, oneOffs, day.date, laned);
    const note = day.retroNote.trim();
    if (note) out.notes.push({ date: day.date, note, reviewedAt: day.retroAt });
  }
  if (out.focusedSeconds > 0) out.onPlanPercent = Math.round((onPlan / out.focusedSeconds) * 100);
  // One planned day is that day, not a typical one.
  if (plannedRows.length > 1) out.typicalDay = { planned: median(plannedRows), done: median(doneRows) };
  // More than half, so at most one category can be named.
  for (const [uid, count] of midDayCategories) if (count * 2 > out.midDay.added) out.midDay.categoryUid = uid;
  const listed = [...byCategory.values()].filter((c) => c.seconds > 0 || c.done > 0);
  out.byCategory = [
    ...listed.filter((c) => c.categoryUid != null).sort((a, b) => b.seconds - a.seconds || b.done - a.done),
    ...listed.filter((c) => c.categoryUid == null),
  ];
  out.unplanned = [...unplanned.values()].sort((a, b) => b.seconds - a.seconds || a.dates[0]!.localeCompare(b.dates[0]!));
  out.routines = [...routines.values()].sort(
    (a, b) => b.dates.length - a.dates.length || b.focusedSeconds - a.focusedSeconds || a.title.localeCompare(b.title),
  );
  out.notDone = [...notDone.values()].sort((a, b) => b.dates.length - a.dates.length || a.dates[0]!.localeCompare(b.dates[0]!));
  return out;
}

/**
 * One day's one-off rows laid onto Not done, the tasks left open on the days before it, walked
 * oldest first. A task's days are one entry, keyed by its uid, and a tick settles it. A task
 * retyped by hand on a later day is a task of its own, so one with no lane, on its first day
 * (`earlier === 0`), joins the latest open entry of its text (`sameText`) whose last day is at most
 * `LOOKBACK_DAYS` before this one, the rule `server/migrations/oneItem.ts` chains rows by: its tick
 * settles that entry, and so does the tick of another such task of its text on its day. Its later
 * days follow the entry it joined, so carrying it on doesn't regroup a past period. The entry
 * shows its latest task's name. A task with a lane neither joins nor is joined.
 */
function addToNotDone(
  notDone: Map<string, OpenPriority>,
  groupOf: Map<string, string>,
  rows: PriorityReview[],
  date: string,
  laned: ReadonlySet<string>,
): void {
  const byText = (p: Priority) => !laned.has(p.uid!) && p.earlier === 0;
  const entryOf = (p: Priority): OpenPriority | undefined => {
    const own = notDone.get(groupOf.get(p.uid!) ?? '');
    if (own || !byText(p)) return own;
    const text = sameText(p.text);
    let latest: OpenPriority | undefined;
    // An entry a task with a lane opened is that task's alone: its key is its uid.
    for (const g of notDone.values()) {
      const last = g.dates.at(-1)!;
      if (!laned.has(g.key) && sameText(g.text) === text && last < date && addDays(last, LOOKBACK_DAYS) >= date && (!latest || last >= latest.dates.at(-1)!))
        latest = g;
    }
    return latest;
  };
  const tickedTexts = new Set<string>();
  for (const { priority: p } of rows) {
    if (!p.done) continue;
    const g = entryOf(p);
    if (g) notDone.delete(g.key);
    if (byText(p)) tickedTexts.add(sameText(p.text));
  }
  for (const { priority: p, focusedSeconds, addedMidDay } of rows) {
    if (p.done || (byText(p) && tickedTexts.has(sameText(p.text)))) continue;
    let g = entryOf(p);
    if (!g) notDone.set(p.uid!, (g = { key: p.uid!, text: '', dates: [], focusedSeconds: 0, addedMidDay: false }));
    groupOf.set(p.uid!, g.key);
    g.text = p.text.trim();
    g.focusedSeconds += focusedSeconds;
    g.addedMidDay ||= addedMidDay;
    addDate(g.dates, date);
  }
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
