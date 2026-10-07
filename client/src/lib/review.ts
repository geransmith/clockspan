import type { Day } from '../types';
import { addDays, addMonths, startOfQuarter, startOfWeek } from '../../../shared/dates.js';
import { breakSeconds } from './breaks';
import { formatDateSpan, formatMonth } from './format';
import { sameText } from '../../../shared/text.js';
import { focusOf, hasContent, reviewDay, type PriorityReview } from './retro';
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

/**
 * A recurring priority's rows across the range, linked by `recurringUid`, whatever their text:
 * the days it was on the list and how many of them it got ticked. Each day stands on its own, so
 * a tick doesn't settle an earlier miss, and none of its rows is a task left open in Not done.
 */
export interface RoutineReview {
  recurringUid: string;
  /** The item's current title (`recurringTitles`); else the latest row's text: the item was deleted, or the board is off. */
  title: string;
  /** The days a row linked to it had text, oldest first; the row opens the latest. */
  dates: string[];
  /** The days it was ticked on. */
  done: number;
  focusedSeconds: number;
}

/** A task not ticked by the end of the range: a one-off's rows left open across days, grouped by card, else by text (`addToNotDone`). */
export interface OpenPriority {
  /** `card:<cardUid>` or `text:<sameText>`. */
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
  /** The recurring priorities on the range's lists: on the most days first, then the most focus, then by title. */
  routines: RoutineReview[];
  /** One-offs not ticked by the end of the range, the ones left open on the most days first, then by date. A routine's rows are in `routines`. */
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
 * even with a break logged. A recurring priority's rows count as priorities in every total and
 * go to `routines` rather than Not done; `recurringTitles` (the board's items by uid) names them.
 */
export function reviewRange(
  days: Day[],
  settings: TimeclockSettings,
  today: string,
  now: number,
  recurringTitles: ReadonlyMap<string, string> = new Map(),
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
    midDay: { added: 0, done: 0 },
    typicalDay: null,
    unplanned: [],
    routines: [],
    notDone: [],
    notes: [],
  };
  const unplanned = new Map<string, UnplannedWork>();
  const routines = new Map<string, RoutineReview>();
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
    const oneOffs: PriorityReview[] = [];
    for (const p of r.planned) {
      if (p.addedMidDay) {
        out.midDay.added++;
        if (p.priority.done) out.midDay.done++;
      }
      const uid = p.priority.recurringUid;
      if (uid == null) {
        oneOffs.push(p);
        continue;
      }
      let g = routines.get(uid);
      if (!g) routines.set(uid, (g = { recurringUid: uid, title: '', dates: [], done: 0, focusedSeconds: 0 }));
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
      const key = sameText(session.label);
      let g = unplanned.get(key);
      if (!g) unplanned.set(key, (g = { key, label: '', seconds: 0, dates: [] }));
      g.label = session.label.trim();
      g.seconds += session.durationSeconds;
      addDate(g.dates, day.date);
    }
    addToNotDone(notDone, oneOffs, day.date);
    const note = day.retroNote.trim();
    if (note) out.notes.push({ date: day.date, note, reviewedAt: day.retroAt });
  }
  if (out.focusedSeconds > 0) out.onPlanPercent = Math.round((onPlan / out.focusedSeconds) * 100);
  // One planned day is that day, not a typical one.
  if (plannedRows.length > 1) out.typicalDay = { planned: median(plannedRows), done: median(doneRows) };
  out.unplanned = [...unplanned.values()].sort((a, b) => b.seconds - a.seconds || a.dates[0]!.localeCompare(b.dates[0]!));
  for (const g of routines.values()) g.title = recurringTitles.get(g.recurringUid) ?? g.title;
  out.routines = [...routines.values()].sort(
    (a, b) => b.dates.length - a.dates.length || b.focusedSeconds - a.focusedSeconds || a.title.localeCompare(b.title),
  );
  out.notDone = [...notDone.values()].sort((a, b) => b.dates.length - a.dates.length || a.dates[0]!.localeCompare(b.dates[0]!));
  return out;
}

const CARD_KEY = 'card:';
const TEXT_KEY = 'text:';

/**
 * One day's rows laid onto Not done, the tasks left open on the days before it, walked oldest
 * first. Rows linked to one card are one task, whatever their text. A row with no card joins
 * the latest task of its text (`sameText`), else starts a task of its own; a carded row whose
 * card has no task yet takes over the cardless task of its text, so a row that got its card
 * since stays one task. A tick settles: a carded row's, its card's task and the cardless task
 * of its text; a cardless row's, every task of its text. The same task left open beside a tick
 * on one day is settled too. Two cards with one title stay two tasks.
 */
function addToNotDone(notDone: Map<string, OpenPriority>, rows: PriorityReview[], date: string): void {
  const ticked = rows.filter((p) => p.priority.done).map((p) => p.priority);
  const tickedCards = new Set(ticked.map((p) => p.cardUid));
  const tickedTexts = new Set(ticked.map((p) => sameText(p.text)));
  const cardlessTicks = new Set(ticked.filter((p) => p.cardUid == null).map((p) => sameText(p.text)));
  for (const [key, g] of notDone) {
    const text = sameText(g.text);
    const settled = key.startsWith(CARD_KEY) ? tickedCards.has(key.slice(CARD_KEY.length)) : tickedTexts.has(text);
    if (settled || cardlessTicks.has(text)) notDone.delete(key);
  }
  for (const { priority: p, focusedSeconds, addedMidDay } of rows) {
    const text = sameText(p.text);
    if (p.done || (p.cardUid != null ? tickedCards.has(p.cardUid) || cardlessTicks.has(text) : tickedTexts.has(text))) continue;
    const g = p.cardUid != null ? cardTask(notDone, p.cardUid, text) : textTask(notDone, text);
    g.text = p.text.trim();
    g.focusedSeconds += focusedSeconds;
    g.addedMidDay ||= addedMidDay;
    addDate(g.dates, date);
  }
}

/**
 * The card's task, taking over the cardless task of `text` when the card has none yet. The task
 * taken over keeps its place in `notDone`, whose order breaks ties in the sort, so a task that
 * got its card sorts where it did before.
 */
function cardTask(notDone: Map<string, OpenPriority>, cardUid: string, text: string): OpenPriority {
  const key = CARD_KEY + cardUid;
  const existing = notDone.get(key);
  if (existing) return existing;
  const cardless = notDone.get(TEXT_KEY + text);
  if (!cardless) {
    const g: OpenPriority = { key, text: '', dates: [], focusedSeconds: 0, addedMidDay: false };
    notDone.set(key, g);
    return g;
  }
  const entries = [...notDone];
  notDone.clear();
  for (const [k, v] of entries) notDone.set(v === cardless ? key : k, v);
  cardless.key = key;
  return cardless;
}

/** The latest task of `text`, carded or not, else a new cardless one. */
function textTask(notDone: Map<string, OpenPriority>, text: string): OpenPriority {
  let latest: OpenPriority | undefined;
  for (const g of notDone.values()) if (sameText(g.text) === text && (!latest || g.dates.at(-1)! >= latest.dates.at(-1)!)) latest = g;
  if (latest) return latest;
  const g: OpenPriority = { key: TEXT_KEY + text, text: '', dates: [], focusedSeconds: 0, addedMidDay: false };
  notDone.set(g.key, g);
  return g;
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
