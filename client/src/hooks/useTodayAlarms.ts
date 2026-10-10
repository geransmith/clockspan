import { useEffect, useState } from 'react';
import { MINUTE_MS } from '../../../shared/dates.js';
import { punchesKey } from '../../../shared/punches.js';
import { dismissByTag, warnQuietly } from '../lib/alerts';
import { LOAD_FAILED } from '../lib/copy';
import { daySettings, dayTimeclock, overtimeOn } from '../lib/timeclock';
import { useAlarms } from './useAlarms';
import { useDay, useRefreshDay } from './useDay';
import { useSettings } from './useSettings';
import { useSettled } from './useSettled';

// A back-fill (clock in, think, lunch out) takes minutes, but focus can stay in a field for
// hours after the last time was saved: a desktop that gets no other click, or an Android
// keyboard closed with Back, which doesn't blur.
const HOLD_MS = 5 * MINUTE_MS;

/**
 * Today's alarms, whatever the sheet is showing. A change to the punches is judged 3 s after
 * the last one, and while a punch time is being typed on today's sheet (`setEditingPunches`)
 * at most five minutes after the later of that change and the start of the hold (a new `ms`
 * restarts `useSettled`'s count), so back-filling a day is judged on the finished set, not on
 * each half-entered state; nothing here is finer than a minute. The punches are compared by
 * their times: a save's answer, or a refresh that changed something else in the day, brings a
 * new list, and one with the same times neither stops the alarms nor restarts the wait. Another
 * device may have punched meanwhile: the copy is fetched again when the tab comes back and every
 * minute, and the alarms sit out a come-back refresh (and the settle after its answer) rather
 * than fire on a lunch this tab never saw taken. They also wait for the settings, like the
 * timer's alerts: judged against the defaults, a longer work day would ring the clock-out alarm
 * on load, with the default sound. Today's failed first load (no punches, so no alarm can ring)
 * is a banner while the page doesn't show today (`todayShown`); the sheet on today and the board
 * show it in place with Try Again.
 */
export function useTodayAlarms(today: string, now: number, openRetro: () => void, todayShown: boolean): { setEditingPunches: (editing: boolean) => void } {
  const { settings, loaded } = useSettings();
  const { day, failed, store } = useDay(today);
  const refreshing = useRefreshDay(today);
  const [editingPunches, setEditingPunches] = useState(false);
  const key = day ? punchesKey(day.punches) : null;
  const settledKey = useSettled(key, editingPunches ? HOLD_MS : 3000);
  const punches = loaded && day && settledKey === key && !refreshing ? day.punches : null;
  // Today's own work-day length (a half day), when one was set, is what the alarms go by.
  // Nothing is memoized: Shell renders every second and useAlarms' effect runs on each tick anyway.
  const workMinutes = day?.workMinutes ?? null;
  const tc = punches ? dayTimeclock({ date: today, punches, workMinutes }, settings, today, now) : null;
  useAlarms(today, tc, daySettings(settings, { workMinutes }), now, {
    overtimeApproved: overtimeOn(settings, Boolean(day?.overtimeApproved)),
    retroDone: Boolean(day?.retroAt),
    approveOvertime: settings.overtimeApproval ? () => void store.setOvertimeApproved(today, true) : undefined,
    openRetro,
  });
  // Up while the failure is out of sight: it goes once today loads, a view shows it, or the date changes.
  const unseen = failed && !todayShown;
  useEffect(() => {
    if (!unseen) return;
    warnQuietly({ title: LOAD_FAILED.today, body: LOAD_FAILED.body, tag: 'load-failed' });
    return () => dismissByTag('load-failed');
  }, [unseen]);
  return { setEditingPunches };
}
