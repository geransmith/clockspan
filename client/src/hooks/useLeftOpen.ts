import { useMemo } from 'react';
import { LOOKBACK_DAYS } from '../../../shared/api.js';
import { addDays } from '../../../shared/dates.js';
import { lastPlan, leftOpen, type LeftOpen } from '../lib/priorities';
import { useRange } from './useRange';

/**
 * What the last day with a plan left unticked, offered on today's list while it has no one-off
 * written. It looks back `LOOKBACK_DAYS`, so a week off still finds the Friday before it, and the
 * board shows a task left open in Next for as long. Read through `useRange`, enabled only while
 * `wanted` (today's sheet with no one-off written and its offer not answered; a routine on the
 * list doesn't count), so a filled list costs no request: once a day, and again whenever
 * `generation` moves (a prune, or a task renamed, filed, noted, made recurring or deleted
 * everywhere: `taskChanged`). A day the day store holds replaces its fetched copy, so a row ticked
 * on that day's sheet since leaves the offer with no second fetch. `planned` is the tasks on the
 * last plan's list, ticked or not, once the read has answered while wanted (null before): Up Next
 * waits for it and leaves them out, so a task left open is never offered there first, nor one
 * ticked there since the board was read. A failed fetch offers nothing: the offer is a shortcut,
 * not worth a banner. `settled` is true once the read has answered or failed, and while it isn't
 * wanted: the sheet holds the whole notice until then, so an answer covers only what was shown
 * (unless the read failed or was never made), and never waits on a read that won't come.
 */
export function useLeftOpen(today: string, wanted: boolean): { leftOpen: LeftOpen | null; planned: ReadonlySet<string | null> | null; settled: boolean } {
  const { days, failed } = useRange(addDays(today, -LOOKBACK_DAYS), addDays(today, -1), wanted);
  const offer = useMemo(() => (days ? leftOpen(days) : null), [days]);
  const planned = useMemo(() => days && new Set(lastPlan(days)?.priorities.map((p) => p.uid)), [days]);
  return { leftOpen: wanted ? offer : null, planned: wanted ? planned : null, settled: !wanted || days != null || failed };
}
