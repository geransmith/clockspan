import { useEffect, useState } from 'react';
import * as api from '../api';
import type { Day } from '../types';

/**
 * Full days for a date range, for the History calendar and the review. The answer is tagged
 * with the range it is for, so stepping to another period reads as loading (both null) straight
 * away without clearing state inside the effect.
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
      .catch((err) => {
        if (!cancelled) setFetched({ key, error: (err as Error).message });
      });
    return () => {
      cancelled = true;
    };
  }, [from, to, key]);
  const current = fetched?.key === key ? fetched : null;
  return { days: current?.days ?? null, error: current?.error ?? null };
}
