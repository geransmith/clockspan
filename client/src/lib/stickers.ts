import { addDays, startOfWeek } from '../../../shared/dates.js';
import type { Day, DaySummary } from '../types';
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

/** Weeks the chart shows, ending with the current one. */
export const STICKER_WEEKS = 4;

export interface StickerDay {
  date: string;
  stickers: StickerId[];
  /** A day row exists for it (an empty cell otherwise). */
  hasData: boolean;
  isFuture: boolean;
}

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
  for (const [i, reason] of STICKER_REASONS.entries()) {
    let at = hash(seed, i * 0x9e37 + 0x5c1e) % STICKER_EMOJI.length;
    while (taken.has(at)) at = (at + 1) % STICKER_EMOJI.length;
    taken.add(at);
    if (reason.id === id) return STICKER_EMOJI[at]!;
  }
  return STICKER_EMOJI[0]!;
}

/** The `GET /days` row for a full day: completed sessions, rows with text. Keeps today's cell live. */
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

/** Monday-to-Sunday rows, oldest first, ending with the week that holds `today`. */
export function stickerWeeks(days: DaySummary[], settings: TimeclockSettings, today: string, now: number, weeks = STICKER_WEEKS): StickerDay[][] {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const lastWeek = startOfWeek(today);
  const out: StickerDay[][] = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const monday = addDays(lastWeek, -7 * w);
    const row: StickerDay[] = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(monday, i);
      const d = byDate.get(date);
      row.push({ date, stickers: d ? stickersForDay(d, settings, today, now) : [], hasData: d != null, isFuture: date > today });
    }
    out.push(row);
  }
  return out;
}

/** Stickers in the window, and days that earned every one. */
export function countStickers(weeks: StickerDay[][]): { total: number; full: number } {
  let total = 0;
  let full = 0;
  for (const row of weeks) {
    for (const d of row) {
      total += d.stickers.length;
      if (d.stickers.length === STICKER_REASONS.length) full++;
    }
  }
  return { total, full };
}
