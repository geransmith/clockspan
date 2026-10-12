import { useEffect, useRef } from 'react';
import { MINUTE_MS } from '../../../shared/dates.js';
import type { AlarmId, Day, Settings } from '../types';
import type { TimeclockResult } from '../lib/timeclock';
import { ALARM_TAG, alarmTargets, describeEvent, describeSnooze, dueEvents, SNOOZE_MINUTES, snoozable, type TargetDay } from '../lib/alarms';
import { alert, dismissByTag, type BannerAction } from '../lib/alerts';
import { ALARM_ACTIONS, MISSED_CLOCK_IN } from '../lib/copy';
import { formatTime, resolveHour12 } from '../lib/format';
import { addToDaySet, readDaySet, USER_KEYS } from '../lib/storage';
import { useLatest } from './useLatest';

/**
 * The day's switches, breaks and running session (which targets are armed is `alarmTargets`), the
 * minute the "Not Clocked In" banner offers, the banner buttons, and whether a timer start is out.
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
  /** The break alarm's Start Break (`useBreak().start`). */
  startBreak: (minutes: number) => Promise<void>;
  /** A timer start is out (`useTimer().starting`), so Start Break does nothing. */
  timerStarting: boolean;
  /** Today's snoozes (`Day.snoozedUntil`), from any device. */
  snoozedUntil: Day['snoozedUntil'];
  /** A banner's Snooze: stores when that alarm rings again. */
  snooze: (id: AlarmId) => void;
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
  const {
    overtimeApproved,
    retroDone,
    breaks,
    timerRunning,
    approveOvertime,
    openRetro,
    missedClockIn,
    clockInAt,
    lunchInNow,
    startBreak,
    timerStarting,
    snoozedUntil,
    snooze,
  } = day;
  // Read at the press, not when the banner went up.
  const starting = useLatest(timerStarting);
  const fired = useRef<{ date: string; set: Set<string> } | null>(null);
  const lastTargets = useRef<Record<string, { at: number; armed: boolean }>>({});
  // Each snoozed alarm's quiet banner, by the time it was raised for: a new time (a second press)
  // raises it again. Not a flag, since a ring banner closed by hand never passes the dismissals here.
  const quiet = useRef(new Map<AlarmId, number>());

  useEffect(() => {
    // Every alarm banner belongs to one day's clock-in. A new day, or a clock-in cleared, takes
    // them down: their buttons would act on a day that is no longer the one being judged. The
    // date is known before the new day has been judged, so its banners go at once.
    const clearBanners = () => {
      for (const id of Object.keys(lastTargets.current)) dismissByTag(ALARM_TAG + id);
      lastTargets.current = {};
      quiet.current.clear();
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
          actions: [{ label: MISSED_CLOCK_IN.action(time), run: () => clockInAt(missedClockIn) }],
          sound: false,
          notifications: false,
        });
      }
      return;
    }
    dismissByTag(CLOCK_IN_TAG);

    const targets = alarmTargets(tc, settings, { overtimeApproved, retroDone, breaks, timerRunning }, now);

    // A banner about a target that just disarmed (lunch taken) or moved (clock-out
    // pushed later) is stale; clear it before evaluating the new state.
    for (const t of targets) {
      const prev = lastTargets.current[t.id];
      if (prev && (prev.armed !== t.armed || Math.abs(prev.at - t.at) >= MINUTE_MS)) {
        dismissByTag(ALARM_TAG + t.id);
        quiet.current.delete(t.id);
      }
      lastTargets.current[t.id] = { at: t.at, armed: t.armed };
    }

    const ctx = { ...settings, clockIn: tc.clockIn, hour12: resolveHour12(settings.timeFormat), now, typedClockOut: tc.typedClockOut };
    const { fire, crossed, snoozed } = dueEvents(targets, settings.alarms, fired.current.set, now, snoozedUntil);
    // Raised from the day, never the press, so every device and tab shows it, a reload included.
    for (const t of snoozed) {
      const until = snoozedUntil[t.id]!;
      if (quiet.current.get(t.id) === until) continue;
      quiet.current.set(t.id, until);
      alert({ ...describeSnooze(t, until, ctx), tone: 'info', sticky: true, tag: ALARM_TAG + t.id, sound: false, notifications: false });
    }
    // A snooze gone before its time (a failed save, Repeat turned Off, the alarm switched off).
    for (const [id, until] of quiet.current) {
      if (now < until && !snoozed.some((t) => t.id === id)) {
        dismissByTag(ALARM_TAG + id);
        quiet.current.delete(id);
      }
    }
    if (crossed.length === 0) return;
    for (const k of crossed) fired.current.set.add(k);
    // With storage blocked (private mode, quota) alarms may repeat after a reload, which is acceptable.
    addToDaySet(USER_KEYS.alarms, dateKey, fired.current.set);

    // Every alarm banner is sticky: the chime is what grabs attention, and the banner has to
    // still be there — saying which alarm and why — when the user looks up. The next
    // threshold replaces it (same tag) and a moved/disarmed target clears it (above).
    const minutes = settings.breakMinutes;
    // The break goes out on the day store's queue and a timer start on the timer's, so either could land first.
    const takeBreak = () => {
      if (!starting.current) void startBreak(minutes);
    };
    for (const e of fire) {
      const { kicker, title, body, tone } = describeEvent(e, ctx);
      // A warning for a typed Clock out has no overtime to approve: the day ends at that time.
      const own =
        e.id === 'clockOut' && approveOvertime && e.target !== tc.typedClockOut
          ? { label: ALARM_ACTIONS.approveOvertime, run: approveOvertime }
          : e.id === 'retro'
            ? { label: ALARM_ACTIONS.openRetro, run: openRetro }
            : // Reached only: a tap on a warning would record a short lunch, and on a repeat a late time.
              e.id === 'lunchEnd' && e.kind === 'due'
              ? { label: ALARM_ACTIONS.lunchInNow, run: lunchInNow }
              : e.id === 'noBreak'
                ? { label: ALARM_ACTIONS.startBreak(minutes), run: takeBreak }
                : undefined;
      const actions: BannerAction[] = own ? [own] : [];
      // Past the deadline only, so a warning seen late counts and one before it doesn't.
      if (now >= e.target && snoozable(e.id, settings.alarms[e.id])) actions.push({ label: ALARM_ACTIONS.snooze(SNOOZE_MINUTES), run: () => snooze(e.id) });
      alert({
        kicker,
        title,
        body,
        tone,
        sticky: true,
        // The break alarm is a nudge, not a deadline: the softer warning sound at every stage.
        chime: e.id === 'noBreak' ? settings.sounds.lead : settings.sounds[e.kind],
        tag: ALARM_TAG + e.id,
        actions: actions.length > 0 ? actions : undefined,
        sound: settings.sound,
        notifications: settings.notifications,
      });
    }
  }, [
    dateKey,
    tc,
    settings,
    now,
    overtimeApproved,
    retroDone,
    breaks,
    timerRunning,
    approveOvertime,
    openRetro,
    missedClockIn,
    clockInAt,
    lunchInNow,
    startBreak,
    starting,
    snoozedUntil,
    snooze,
  ]);
}
