import { useCallback, useMemo, useState } from 'react';
import { MINUTE_MS } from '../../../shared/dates.js';
import { punchesKey } from '../../../shared/punches.js';
import { computeTimeclock, daySettings, overtimeOn } from '../lib/timeclock';
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
 * their times: every refresh brings a new list, and one with the same times neither stops the
 * alarms nor restarts the wait. Another device may have punched meanwhile: the copy is fetched
 * again when the tab comes back and every minute, and the alarms sit out a come-back refresh
 * (and the settle after its answer) rather than fire on a lunch this tab never saw taken. They
 * also wait for the settings, like the timer's alerts: judged against the defaults, a longer
 * work day would ring the clock-out alarm on load, with the default sound.
 */
export function useTodayAlarms(today: string, now: number, openRetro: () => void): { setEditingPunches: (editing: boolean) => void } {
  const { settings, loaded } = useSettings();
  const { day, store } = useDay(today);
  const refreshing = useRefreshDay(today);
  const [editingPunches, setEditingPunches] = useState(false);
  const key = day ? punchesKey(day.punches) : null;
  const settledKey = useSettled(key, editingPunches ? HOLD_MS : 3000);
  const punches = loaded && day && settledKey === key && !refreshing ? day.punches : null;
  // Today's own work-day length (a half day), when one was set, is what the alarms go by.
  const workMinutes = day?.workMinutes ?? null;
  const todaySettings = useMemo(() => daySettings(settings, { workMinutes }), [settings, workMinutes]);
  const tc = useMemo(() => (punches ? computeTimeclock(punches, todaySettings, now) : null), [punches, todaySettings, now]);
  const overtimeApproved = overtimeOn(settings, Boolean(day?.overtimeApproved));
  const approveOvertime = useCallback(() => void store.setOvertimeApproved(today, true), [store, today]);
  useAlarms(today, tc, todaySettings, now, {
    overtimeApproved,
    retroDone: Boolean(day?.retroAt),
    approveOvertime: settings.overtimeApproval ? approveOvertime : undefined,
    openRetro,
  });
  return { setEditingPunches };
}
