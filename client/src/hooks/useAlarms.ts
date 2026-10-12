import { useEffect, useRef } from 'react';
import { MINUTE_MS } from '../../../shared/dates.js';
import type { Settings } from '../types';
import type { TimeclockResult } from '../lib/timeclock';
import { ALARM_TAG, alarmTargets, describeEvent, dueEvents, type TargetDay } from '../lib/alarms';
import { alert, dismissByTag } from '../lib/alerts';
import { ALARM_ACTIONS, MISSED_CLOCK_IN } from '../lib/copy';
import { formatTime, resolveHour12 } from '../lib/format';
import { addToDaySet, readDaySet, USER_KEYS } from '../lib/storage';

/**
 * The day's switches (which targets are armed is `alarmTargets`), the minute the "Not Clocked In"
 * banner offers, and the banner buttons.
 */
export interface AlarmDayState extends TargetDay {
  /** Left out while the Overtime approval setting is off. */
  approveOvertime?: () => void;
  openRetro: () => void;
  /** The minute the "Not Clocked In" banner offers (`missedClockIn`), or null for no banner. */
  missedClockIn: number | null;
  /** The "Not Clocked In" banner's Clock In. */
  clockInAt: (at: number) => void;
  /** The "Lunch Is Over" banner's Lunch In Now, which fills an empty Lunch in with the minute of the press. */
  lunchInNow: () => void;
}

// Not under ALARM_TAG: the banner is no alarm (no chime, no bell), and `clearBanners` sweeps
// only the targets.
const CLOCK_IN_TAG = 'clock-in';
const CLOCK_IN_KEY = 'clockIn:missing';

/**
 * App-level alarm engine for today's timeclock. Runs every tick: `alarmTargets` says which
 * deadlines are armed, the pure scheduler decides what is due, and the fired-set (today's,
 * stored under `USER_KEYS.alarms`) prevents repeats.
 */
export function useAlarms(dateKey: string, tc: TimeclockResult | null, settings: Settings, now: number, day: AlarmDayState): void {
  const { overtimeApproved, retroDone, approveOvertime, openRetro, missedClockIn, clockInAt, lunchInNow } = day;
  const fired = useRef<{ date: string; set: Set<string> } | null>(null);
  const lastTargets = useRef<Record<string, { at: number; armed: boolean }>>({});

  useEffect(() => {
    // Every alarm banner belongs to one day's clock-in. A new day, or a clock-in cleared, takes
    // them down: their buttons would act on a day that is no longer the one being judged. The
    // date is known before the new day has been judged, so its banners go at once.
    const clearBanners = () => {
      for (const id of Object.keys(lastTargets.current)) dismissByTag(ALARM_TAG + id);
      lastTargets.current = {};
    };
    if (fired.current?.date !== dateKey) {
      clearBanners();
      dismissByTag(CLOCK_IN_TAG);
      fired.current = { date: dateKey, set: new Set() };
    }
    // Not judged yet (settings or punches still settling): leave the rest as it is.
    if (!tc) return;
    // Read every time, not once: a second tab on this device writes what it fired, and
    // without its keys both tabs would ring every alarm.
    for (const k of readDaySet(USER_KEYS.alarms, dateKey)) fired.current.set.add(k);
    if (tc.clockIn == null) {
      clearBanners();
      // Up once a day, and down with nothing left to offer, a Clock in (below) or a new day. A later
      // change to the first start neither raises it again nor moves the minute its button writes.
      // Only a shown tab raises and records it: with no chime, a banner in a hidden tab is a
      // banner missed.
      if (missedClockIn == null) dismissByTag(CLOCK_IN_TAG);
      else if (document.visibilityState === 'visible' && !fired.current.set.has(CLOCK_IN_KEY)) {
        fired.current.set.add(CLOCK_IN_KEY);
        addToDaySet(USER_KEYS.alarms, dateKey, fired.current.set);
        const time = formatTime(missedClockIn, resolveHour12(settings.timeFormat));
        alert({
          kicker: MISSED_CLOCK_IN.kicker,
          title: MISSED_CLOCK_IN.title,
          body: MISSED_CLOCK_IN.body(time),
          tone: 'info',
          sticky: true,
          tag: CLOCK_IN_TAG,
          action: { label: MISSED_CLOCK_IN.action(time), run: () => clockInAt(missedClockIn) },
          sound: false,
          notifications: false,
        });
      }
      return;
    }
    dismissByTag(CLOCK_IN_TAG);

    const targets = alarmTargets(tc, settings, { overtimeApproved, retroDone });

    // A banner about a target that just disarmed (lunch taken) or moved (clock-out
    // pushed later) is stale; clear it before evaluating the new state.
    for (const t of targets) {
      const prev = lastTargets.current[t.id];
      if (prev && (prev.armed !== t.armed || Math.abs(prev.at - t.at) >= MINUTE_MS)) dismissByTag(ALARM_TAG + t.id);
      lastTargets.current[t.id] = { at: t.at, armed: t.armed };
    }

    const { fire, crossed } = dueEvents(targets, settings.alarms, fired.current.set, now);
    if (crossed.length === 0) return;
    for (const k of crossed) fired.current.set.add(k);
    // With storage blocked (private mode, quota) alarms may repeat after a reload, which is acceptable.
    addToDaySet(USER_KEYS.alarms, dateKey, fired.current.set);

    // Every alarm banner is sticky: the chime is what grabs attention, and the banner has to
    // still be there — saying which alarm and why — when the user looks up. The next
    // threshold replaces it (same tag) and a moved/disarmed target clears it (above).
    const ctx = { ...settings, clockIn: tc.clockIn, hour12: resolveHour12(settings.timeFormat), now, typedClockOut: tc.typedClockOut };
    for (const e of fire) {
      const { kicker, title, body, tone } = describeEvent(e, ctx);
      // A warning for a typed Clock out has no overtime to approve: the day ends at that time.
      const action =
        e.id === 'clockOut' && approveOvertime && e.target !== tc.typedClockOut
          ? { label: ALARM_ACTIONS.approveOvertime, run: approveOvertime }
          : e.id === 'retro'
            ? { label: ALARM_ACTIONS.openRetro, run: openRetro }
            : // Reached only: a tap on a warning would record a short lunch, and on a repeat a late time.
              e.id === 'lunchEnd' && e.kind === 'due'
              ? { label: ALARM_ACTIONS.lunchInNow, run: lunchInNow }
              : undefined;
      alert({
        kicker,
        title,
        body,
        tone,
        sticky: true,
        chime: settings.sounds[e.kind],
        tag: ALARM_TAG + e.id,
        action,
        sound: settings.sound,
        notifications: settings.notifications,
      });
    }
  }, [dateKey, tc, settings, now, overtimeApproved, retroDone, approveOvertime, openRetro, missedClockIn, clockInAt, lunchInNow]);
}
