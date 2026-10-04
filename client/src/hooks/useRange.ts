import { useEffect, useMemo, useState } from 'react';
import type { Day } from '../types';
import { useDays, useDayStore } from './useDay';

/**
 * `fetched` with the day store's copy in place of each day it holds in [from, to] (or added), in
 * date order; null while `fetched` is. So a view built on a range shows an edit at once, even one
 * whose save was still out when the range was asked for.
 */
export function useHeldOver(fetched: Day[] | null | undefined, from: string, to: string): Day[] | null {
  const { days: held } = useDays();
  return useMemo(() => {
    if (!fetched) return null;
    const byDate = new Map(fetched.map((d) => [d.date, d]));
    for (const d of Object.values(held)) if (d.date >= from && d.date <= to) byDate.set(d.date, d);
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [fetched, held, from, to]);
}

/**
 * Full days for a date range, in date order, for the week line, the History calendar and the
 * review. Read through the day store (`readRange`), whose held days take the answer unless a
 * change was confirmed meanwhile, then laid over with the store's copies (`useHeldOver`). Asked
 * again after a prune (`generation`), whose deleted days the answer on screen may still hold.
 * The answer is tagged with the range it is for, so stepping to another period reads as
 * loading (both null) straight away without clearing state inside the effect.
 */
export function useRange(from: string, to: string): { days: Day[] | null; error: string | null } {
  const key = `${from}:${to}`;
  const { readRange } = useDayStore();
  const { generation } = useDays();
  const [fetched, setFetched] = useState<{ key: string; days?: Day[]; error?: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    readRange(from, to)
      .then((days) => {
        if (!cancelled) setFetched({ key, days });
      })
      .catch((err: unknown) => {
        if (!cancelled) setFetched({ key, error: (err as Error).message });
      });
    return () => {
      cancelled = true;
    };
  }, [from, to, key, readRange, generation]);
  const current = fetched?.key === key ? fetched : null;
  const days = useHeldOver(current?.days, from, to);
  return { days, error: current?.error ?? null };
}
