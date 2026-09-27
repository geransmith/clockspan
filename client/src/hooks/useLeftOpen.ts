import { useCallback, useEffect, useState } from 'react';
import * as api from '../api';
import { addDays } from '../lib/format';
import { leftOpen, type LeftOpen } from '../lib/priorities';
import { readStored, writeStored } from '../lib/storage';

/** How far back the last plan is looked for: a week off still finds the Friday before it. */
const LOOKBACK_DAYS = 14;
const DISMISSED_KEY = 'focus:left-open-dismissed';

/**
 * What the last day with a plan left unticked, offered on today's empty list. Fetched once a
 * day and only while `wanted` (today's sheet with nothing written), so a filled list costs no
 * request. "Start fresh" holds for the rest of the day. A failed fetch offers nothing: the
 * offer is a shortcut, not worth a banner.
 */
export function useLeftOpen(today: string, wanted: boolean): { leftOpen: LeftOpen | null; dismiss: () => void } {
  const [dismissedOn, setDismissedOn] = useState(() => readStored(DISMISSED_KEY));
  const [found, setFound] = useState<{ today: string; value: LeftOpen | null } | null>(null);
  const active = wanted && dismissedOn !== today;
  const looked = found?.today === today;
  useEffect(() => {
    if (!active || looked) return;
    let cancelled = false;
    void api
      .getRange(addDays(today, -LOOKBACK_DAYS), addDays(today, -1))
      .then((r) => leftOpen(r.days))
      .catch(() => null)
      .then((value) => {
        if (!cancelled) setFound({ today, value });
      });
    return () => {
      cancelled = true;
    };
  }, [active, looked, today]);
  const dismiss = useCallback(() => {
    writeStored(DISMISSED_KEY, today);
    setDismissedOn(today);
  }, [today]);
  return { leftOpen: active && found?.today === today ? found.value : null, dismiss };
}
