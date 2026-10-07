import type { Day, Punch, Settings } from '../types';
import { hash } from './celebrate';
import { STICKER_EMOJI } from './copy';
import { hasText } from '../../../shared/priorities.js';
import { focusOf } from './retro';
import { lunchTracked, type TimeclockResult, type TimeclockSettings } from './timeclock';

export type StickerId = 'clockedOut' | 'lunch' | 'priorities' | 'focus' | 'reviewed';

/** What a day can earn a sticker for, in the order the legend lists them. */
export const STICKER_REASONS: { id: StickerId; label: string }[] = [
  { id: 'clockedOut', label: 'Clocked out' },
  { id: 'lunch', label: 'Lunch taken' },
  { id: 'priorities', label: 'All priorities done' },
  { id: 'focus', label: 'Focus session logged' },
  { id: 'reviewed', label: 'Retrospective reviewed' },
];

/** Each reason's label, for a cell's name and a sticker's tooltip. */
export const STICKER_LABELS = Object.fromEntries(STICKER_REASONS.map((r) => [r.id, r.label])) as Record<StickerId, string>;

/** What the chart needs to judge a day: its timeclock, and whether hours and lunch are tracked at all. */
export type StickerSettings = TimeclockSettings & Pick<Settings, 'trackHours' | 'lunchPunches'>;

/**
 * The reasons a day can earn a sticker for this user. With hours not tracked there is no
 * clocking out to reward, and with the meal periods and lunch punches both off no lunch, so the
 * chart, its legend and a full day go without them.
 */
export function stickerReasons(settings: Pick<Settings, 'trackHours' | 'mealRules' | 'lunchPunches'>): { id: StickerId; label: string }[] {
  return STICKER_REASONS.filter((r) => (r.id !== 'clockedOut' || settings.trackHours) && (r.id !== 'lunch' || lunchTracked(settings)));
}

/** Every priority written was ticked: the priorities sticker, and the day panel's "all done". */
export function allPrioritiesDone(d: Pick<DaySummary, 'prioritiesDone' | 'prioritiesTotal'>): boolean {
  return d.prioritiesTotal > 0 && d.prioritiesDone === d.prioritiesTotal;
}

/**
 * The stickers one day earned out of `reasons` (from `stickerReasons`), in their order, judged
 * on its timeclock (`dayTimeclock`) worked out once by the caller. A day never wears one the
 * legend leaves out, which `calendarMonth`'s `full` relies on.
 */
export function stickersForDay(d: DaySummary, tc: TimeclockResult, reasons: { id: StickerId }[]): StickerId[] {
  const earned: Record<StickerId, boolean> = {
    clockedOut: tc.state === 'done',
    lunch: tc.lunchStatus === 'taken',
    priorities: allPrioritiesDone(d),
    focus: d.focusSeconds > 0,
    reviewed: d.retroAt != null,
  };
  return reasons.filter((r) => earned[r.id]).map((r) => r.id);
}

/**
 * Which creature a sticker is: fixed per day and reason, so the chart never reshuffles, and
 * no two stickers on one day are the same (a repeat steps to the next free one).
 */
export function stickerEmoji(date: string, id: StickerId): string {
  const seed = Number(date.replace(/-/g, ''));
  const taken = new Set<number>();
  // Each reason's pick depends on the ones before it in legend order, so walk up to this one.
  const want = STICKER_REASONS.findIndex((r) => r.id === id);
  let at = 0;
  for (let i = 0; i <= want; i++) {
    at = hash(seed, i * 0x9e37 + 0x5c1e) % STICKER_EMOJI.length;
    while (taken.has(at)) at = (at + 1) % STICKER_EMOJI.length;
    taken.add(at);
  }
  return STICKER_EMOJI[at]!;
}

/** A day rolled up for the History calendar: what its stickers and the day panel's numbers need. */
export interface DaySummary {
  date: string;
  punches: Punch[];
  focusSeconds: number;
  /** Completed sessions, for the day panel's Focused tile. */
  focusSessions: number;
  prioritiesDone: number;
  prioritiesTotal: number;
  retroAt: number | null;
  /** The day's own work-day length, if it had one (`daySettings`). */
  workMinutes: number | null;
}

/** A full day rolled up for the calendar: completed sessions, rows with text. Keeps today's cell live. */
export function daySummaryOf(day: Day): DaySummary {
  const withText = day.priorities.filter(hasText);
  const focus = focusOf(day.sessions);
  return {
    date: day.date,
    punches: day.punches,
    focusSeconds: focus.seconds,
    focusSessions: focus.count,
    prioritiesDone: withText.filter((p) => p.done).length,
    prioritiesTotal: withText.length,
    retroAt: day.retroAt,
    workMinutes: day.workMinutes,
  };
}

export interface StickerCount {
  total: number;
  /** Days that earned every sticker. */
  full: number;
  /** Days that earned each one: the legend's numbers. */
  byReason: Record<StickerId, number>;
}

/** Stickers on the calendar's month (filler cells carry none). */
export function countStickers(weeks: { stickers: StickerId[]; full: boolean }[][]): StickerCount {
  const byReason = Object.fromEntries(STICKER_REASONS.map((r) => [r.id, 0])) as Record<StickerId, number>;
  let total = 0;
  let full = 0;
  for (const row of weeks) {
    for (const d of row) {
      total += d.stickers.length;
      if (d.full) full++;
      for (const id of d.stickers) byReason[id]++;
    }
  }
  return { total, full, byReason };
}
