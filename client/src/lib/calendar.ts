import { addDays, addMonths, startOfWeek } from '../../../shared/dates.js';
import type { DaySummary } from '../types';

export interface CalendarDay {
  date: string;
  /** A filler cell before the 1st or after the last day: blank, never selectable. */
  outside: boolean;
  isFuture: boolean;
  /** A day row exists for it (the cell is empty otherwise). */
  hasData: boolean;
}

/**
 * The month that starts on `monthStart` as Monday-to-Sunday rows, oldest first, padded to
 * whole weeks with `outside` cells. The days are looked up by date; anything else the cell
 * shows is derived by the caller from the same summaries.
 */
export function calendarMonth(days: DaySummary[], today: string, monthStart: string): CalendarDay[][] {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const monthEnd = addDays(addMonths(monthStart, 1), -1);
  const out: CalendarDay[][] = [];
  for (let monday = startOfWeek(monthStart); monday <= monthEnd; monday = addDays(monday, 7)) {
    const row: CalendarDay[] = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(monday, i);
      const outside = date < monthStart || date > monthEnd;
      row.push({ date, outside, isFuture: date > today, hasData: !outside && byDate.has(date) });
    }
    out.push(row);
  }
  return out;
}
