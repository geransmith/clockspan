import { useEffect, useMemo, useState } from 'react';
import * as api from '../api';
import type { Day } from '../types';
import { useDayStore } from './useDay';

/**
 * Full days for a date range, in date order, for the week line, the History calendar and the
 * review. A day the day store holds (today, the day on screen, one edited since) replaces the
 * fetched copy, so all three show an edit at once, even one whose save was still out when the
 * range was asked for. The answer is tagged with the range it is for, so stepping to another
 * period reads as loading (both null) straight away without clearing state inside the effect.
 */
export function useRange(from: string, to: string): { days: Day[] | null; error: string | null } {
  const key = `${from}:${to}`;
  const [fetched, setFetched] = useState<{ key: string; days?: Day[]; error?: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .getRange(from, to)
      .then((r) => {
        if (!cancelled) setFetched({ key, days: r.days });
      })
      .catch((err: unknown) => {
        if (!cancelled) setFetched({ key, error: (err as Error).message });
      });
    return () => {
      cancelled = true;
    };
  }, [from, to, key]);
  const current = fetched?.key === key ? fetched : null;
  const { days: held } = useDayStore();
  const answered = current?.days;
  const days = useMemo(() => {
    if (!answered) return null;
    const byDate = new Map(answered.map((d) => [d.date, d]));
    for (const d of Object.values(held)) if (d.date >= from && d.date <= to) byDate.set(d.date, d);
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [answered, held, from, to]);
  return { days, error: current?.error ?? null };
}
