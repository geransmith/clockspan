import type { Day, DaySummary } from '../types';
import type { CalendarDay } from './calendar';
import { hash } from './celebrate';
import { STICKER_EMOJI } from './copy';
import { timeclockForDate, type TimeclockSettings } from './timeclock';

export type StickerId = 'clockedOut' | 'lunch' | 'priorities' | 'focus' | 'reviewed';

/** What a day can earn a sticker for, in the order the legend lists them. */
export const STICKER_REASONS: { id: StickerId; label: string }[] = [
  { id: 'clockedOut', label: 'Clocked out' },
  { id: 'lunch', label: 'Lunch taken' },
  { id: 'priorities', label: 'All priorities done' },
  { id: 'focus', label: 'Focus session logged' },
  { id: 'reviewed', label: 'Retrospective reviewed' },
];

/** The stickers one day earned. Past days are judged frozen, like everywhere else. */
export function stickersForDay(d: DaySummary, settings: TimeclockSettings, today: string, now: number): StickerId[] {
  const tc = timeclockForDate(d.punches, settings, d.date, today, now);
  const out: StickerId[] = [];
  if (tc.state === 'done') out.push('clockedOut');
  if (tc.lunchStatus === 'taken') out.push('lunch');
  if (d.prioritiesTotal > 0 && d.prioritiesDone === d.prioritiesTotal) out.push('priorities');
  if (d.focusSeconds > 0) out.push('focus');
  if (d.retroAt != null) out.push('reviewed');
  return out;
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

/** A full day rolled up for the calendar: completed sessions, rows with text. Keeps today's cell live. */
export function daySummaryOf(day: Day): DaySummary {
  const withText = day.priorities.filter((p) => p.text.trim() !== '');
  return {
    date: day.date,
    punches: day.punches,
    focusSeconds: day.sessions.reduce((sum, s) => sum + (s.status === 'completed' ? (s.durationSeconds ?? 0) : 0), 0),
    prioritiesDone: withText.filter((p) => p.done).length,
    prioritiesTotal: withText.length,
    retroAt: day.retroAt,
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
export function countStickers(weeks: CalendarDay[][]): StickerCount {
  const byReason = Object.fromEntries(STICKER_REASONS.map((r) => [r.id, 0])) as Record<StickerId, number>;
  let total = 0;
  let full = 0;
  for (const row of weeks) {
    for (const d of row) {
      total += d.stickers.length;
      if (d.stickers.length === STICKER_REASONS.length) full++;
      for (const id of d.stickers) byReason[id]++;
    }
  }
  return { total, full, byReason };
}
