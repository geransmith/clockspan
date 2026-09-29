import { useMemo } from 'react';
import type { Day } from '../types';
import { startOfWeek } from '../../../shared/dates.js';
import { useDayStore } from './useDay';
import { useRange } from './useRange';

/**
 * The days of `date`'s week up to and including it, for the week line. They come from the range
 * the week spans, and any the day store holds (the day on screen, one edited since) replace
 * the fetched copy, so the line moves with the sheet. Null until the range has answered.
 */
export function useWeek(date: string): Day[] | null {
  const from = startOfWeek(date);
  const { days: fetched } = useRange(from, date);
  const { days: held } = useDayStore();
  return useMemo(() => {
    if (!fetched) return null;
    const byDate = new Map(fetched.map((d) => [d.date, d]));
    for (const d of Object.values(held)) if (d.date >= from && d.date <= date) byDate.set(d.date, d);
    return [...byDate.values()];
  }, [fetched, held, from, date]);
}
