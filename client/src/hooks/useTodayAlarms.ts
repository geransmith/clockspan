import { useCallback, useMemo, useState } from 'react';
import { samePunches } from '../../../shared/punches.js';
import { computeTimeclock, daySettings } from '../lib/timeclock';
import { useAlarms } from './useAlarms';
import { useDay, useRefreshDay } from './useDay';
import { useSettings } from './useSettings';
import { useSettled } from './useSettled';

/**
 * Today's alarms, whatever the sheet is showing. While a punch time is being typed on today's
 * sheet (`setEditingPunches`) and for a few seconds after, a change to the punches waits, so
 * back-filling a day (clock in, think, lunch out) is judged on the finished set, not on each
 * half-entered state; nothing here is finer than a minute. The held punches are compared with
 * the day's by value: every refresh brings a new list with the same times, which must not
 * stop the alarms while a field has focus. Another device may have punched meanwhile: the copy
 * is fetched again when the tab comes back and every minute, and the alarms sit out a
 * come-back refresh (and the settle after its answer) rather than fire on a lunch this tab
 * never saw taken. They also wait for the settings, like the timer's alerts: judged against
 * the defaults, a longer work day would ring the clock-out alarm on load, with the default sound.
 */
export function useTodayAlarms(today: string, now: number, openRetro: () => void): { setEditingPunches: (editing: boolean) => void } {
  const { settings, loaded } = useSettings();
  const { day, store } = useDay(today);
  const { setOvertimeApproved } = store;
  const refreshing = useRefreshDay(today);
  const [editingPunches, setEditingPunches] = useState(false);
  const punches = useSettled(day?.punches, 3000, editingPunches);
  const settled = loaded && punches != null && day != null && samePunches(punches, day.punches) && !refreshing;
  // Today's own work-day length (a half day), when one was set, is what the alarms go by.
  const workMinutes = day?.workMinutes ?? null;
  const todaySettings = useMemo(() => daySettings(settings, { workMinutes }), [settings, workMinutes]);
  const tc = useMemo(() => (settled ? computeTimeclock(punches, todaySettings, now) : null), [settled, punches, todaySettings, now]);
  // A day flagged while the feature was on stays silent only while it is still on.
  const overtimeApproved = settings.overtimeApproval && Boolean(day?.overtimeApproved);
  // On the setter, which keeps its identity: the store is a new object whenever a day changes,
  // and the alarms would run again for each.
  const approveOvertime = useCallback(() => void setOvertimeApproved(today, true), [setOvertimeApproved, today]);
  useAlarms(today, tc, todaySettings, now, {
    overtimeApproved,
    retroDone: Boolean(day?.retroAt),
    approveOvertime: settings.overtimeApproval ? approveOvertime : undefined,
    openRetro,
  });
  return { setEditingPunches };
}
