import { addDays, addMonths, startOfWeek } from '../../../shared/dates.js';
import { stickerReasons, stickersForDay, type DaySummary, type StickerId, type StickerSettings } from './stickers';
import { dayTimeclock, type TimeclockResult } from './timeclock';

export interface CalendarDay {
  date: string;
  /** A filler cell before the 1st or after the last day: blank, never selectable. */
  outside: boolean;
  isFuture: boolean;
  /** The day has something on it (the caller passes only the days `hasContent` keeps); the cell is empty otherwise. */
  hasData: boolean;
  /** What the day earned (see `stickersForDay`); empty for a filler. */
  stickers: StickerId[];
  /** The day's timeclock, worked out once for its stickers and its cell; null without data. */
  timeclock: TimeclockResult | null;
}

/**
 * The month that starts on `monthStart` as Monday-to-Sunday rows, oldest first, padded to
 * whole weeks with `outside` cells; Monday-to-Friday rows when weekends are off, so a
 * weekend day is simply not on the calendar and never counted. The days are looked up by
 * date, and each cell's timeclock and stickers are worked out here, once, for the cell and the
 * sticker count.
 */
export function calendarMonth(
  days: DaySummary[],
  settings: StickerSettings & { showWeekends: boolean },
  today: string,
  now: number,
  monthStart: string,
): CalendarDay[][] {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const monthEnd = addDays(addMonths(monthStart, 1), -1);
  const width = settings.showWeekends ? 7 : 5;
  const reasons = stickerReasons(settings);
  const out: CalendarDay[][] = [];
  for (let monday = startOfWeek(monthStart); monday <= monthEnd; monday = addDays(monday, 7)) {
    const row: CalendarDay[] = [];
    for (let i = 0; i < width; i++) {
      const date = addDays(monday, i);
      const outside = date < monthStart || date > monthEnd;
      const d = outside ? undefined : byDate.get(date);
      const timeclock = d ? dayTimeclock(d, settings, today, now) : null;
      row.push({
        date,
        outside,
        isFuture: date > today,
        hasData: d != null,
        stickers: d && timeclock ? stickersForDay(d, timeclock, reasons) : [],
        timeclock,
      });
    }
    // A month that starts on a Saturday would otherwise open with a row of nothing but filler.
    if (row.some((d) => !d.outside)) out.push(row);
  }
  return out;
}
