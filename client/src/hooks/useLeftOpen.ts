import { useCallback, useMemo, useState } from 'react';
import { LOOKBACK_DAYS } from '../../../shared/api.js';
import { addDays } from '../../../shared/dates.js';
import { leftOpen, type LeftOpen } from '../lib/priorities';
import { readStored, USER_KEYS, writeStored } from '../lib/storage';
import { useRange } from './useRange';

/**
 * What the last day with a plan left unticked, offered on today's list while it has no one-off
 * written. It looks back `LOOKBACK_DAYS`, so a week off still finds the Friday before it, and the
 * board shows a task left open in Next for as long. Read through `useRange`, enabled only while
 * `wanted` (today's sheet with no one-off written; a routine on the list doesn't count), so a
 * filled list costs no request: once a day, and again after a prune or a task deleted
 * everywhere. A day the day store holds replaces its fetched copy, so a row ticked on that day's
 * sheet since leaves the offer with no second fetch. "Start fresh" holds for the rest of the day.
 * A failed fetch offers nothing: the offer is a shortcut, not worth a banner.
 */
export function useLeftOpen(today: string, wanted: boolean): { leftOpen: LeftOpen | null; dismiss: () => void } {
  const [dismissedOn, setDismissedOn] = useState(() => readStored(USER_KEYS.leftOpenDismissed));
  const active = wanted && dismissedOn !== today;
  const { days } = useRange(addDays(today, -LOOKBACK_DAYS), addDays(today, -1), active);
  const offer = useMemo(() => (days ? leftOpen(days) : null), [days]);
  const dismiss = useCallback(() => {
    writeStored(USER_KEYS.leftOpenDismissed, today);
    setDismissedOn(today);
  }, [today]);
  return { leftOpen: active ? offer : null, dismiss };
}
