import { useCallback, useEffect, useMemo, useState } from 'react';
import { addDays } from '../../../shared/dates.js';
import { leftOpen, type LeftOpen } from '../lib/priorities';
import { readStored, USER_KEYS, writeStored } from '../lib/storage';
import type { Day } from '../types';
import { useDayStore } from './useDay';
import { useHeldOver } from './useRange';

/** How far back the last plan is looked for: a week off still finds the Friday before it. */
const LOOKBACK_DAYS = 14;

/**
 * What the last day with a plan left unticked, offered on today's empty list. Fetched once a
 * day and only while `wanted` (today's sheet with nothing written), so a filled list costs no
 * request, and again after a prune. A day the day store holds replaces its fetched copy
 * (`useHeldOver`), so a row ticked on that day's sheet since leaves the offer with no second
 * fetch. "Start fresh" holds for the rest of the day. A failed fetch offers nothing: the offer
 * is a shortcut, not worth a banner.
 */
export function useLeftOpen(today: string, wanted: boolean): { leftOpen: LeftOpen | null; dismiss: () => void } {
  const { readRange, generation } = useDayStore();
  const [dismissedOn, setDismissedOn] = useState(() => readStored(USER_KEYS.leftOpenDismissed));
  const [found, setFound] = useState<{ today: string; generation: number; days: Day[] | null } | null>(null);
  const active = wanted && dismissedOn !== today;
  const looked = found?.today === today && found.generation === generation;
  const from = addDays(today, -LOOKBACK_DAYS);
  const to = addDays(today, -1);
  useEffect(() => {
    if (!active || looked) return;
    let cancelled = false;
    void readRange(from, to)
      .catch(() => null)
      .then((days) => {
        if (!cancelled) setFound({ today, generation, days });
      });
    return () => {
      cancelled = true;
    };
  }, [active, looked, today, generation, from, to, readRange]);
  const days = useHeldOver(found?.today === today ? found.days : null, from, to);
  const offer = useMemo(() => (days ? leftOpen(days) : null), [days]);
  const dismiss = useCallback(() => {
    writeStored(USER_KEYS.leftOpenDismissed, today);
    setDismissedOn(today);
  }, [today]);
  return { leftOpen: active ? offer : null, dismiss };
}
