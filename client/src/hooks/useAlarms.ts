import { useEffect, useRef } from 'react';
import { MINUTE_MS } from '../../../shared/dates.js';
import type { Settings } from '../types';
import type { TimeclockResult } from '../lib/timeclock';
import { alarmTargets, describeEvent, dueEvents, type TargetDay } from '../lib/alarms';
import { alert, dismissByTag } from '../lib/alerts';
import { ALARM_ACTIONS } from '../lib/copy';
import { resolveHour12 } from '../lib/format';
import { pruneStored, readStoredJson, USER_KEYS, writeStored } from '../lib/storage';

const STORAGE_PREFIX = USER_KEYS.alarms;

/** The keys stored for a day: what this tab, or another one open on the same device, already fired. */
function storedFired(dateKey: string): string[] {
  const stored = readStoredJson(STORAGE_PREFIX + dateKey);
  return Array.isArray(stored) ? stored.filter((k): k is string => typeof k === 'string') : [];
}

/** The day's switches (which targets are armed is `alarmTargets`) and the banner buttons. */
export interface AlarmDayState extends TargetDay {
  /** Left out while the Overtime approval setting is off. */
  approveOvertime?: () => void;
  openRetro: () => void;
}

/**
 * App-level alarm engine for today's timeclock. Runs every tick: `alarmTargets` says which
 * deadlines are armed, the pure scheduler decides what is due, and the fired-set (persisted
 * per day) prevents repeats.
 */
export function useAlarms(dateKey: string, tc: TimeclockResult | null, settings: Settings, now: number, day: AlarmDayState): void {
  const { overtimeApproved, retroDone, approveOvertime, openRetro } = day;
  const fired = useRef<{ date: string; set: Set<string> } | null>(null);
  const lastTargets = useRef<Record<string, { at: number; armed: boolean }>>({});

  useEffect(() => {
    // Not judged yet (settings or punches still settling): leave everything as it is.
    if (!tc) return;
    // Every alarm banner belongs to one day's clock-in. A new day, or a clock-in cleared, takes
    // them down: their buttons would act on a day that is no longer the one being judged.
    const clearBanners = () => {
      for (const id of Object.keys(lastTargets.current)) dismissByTag(`alarm:${id}`);
      lastTargets.current = {};
    };
    if (fired.current?.date !== dateKey) {
      if (fired.current) clearBanners();
      // Other days' keys are dropped so the store never grows.
      pruneStored(STORAGE_PREFIX, STORAGE_PREFIX + dateKey);
      fired.current = { date: dateKey, set: new Set() };
    }
    if (tc.clockIn == null) {
      clearBanners();
      return;
    }
    // Read every time, not once: a second tab on this device writes what it fired, and
    // without its keys both tabs would ring every alarm.
    for (const k of storedFired(dateKey)) fired.current.set.add(k);

    const targets = alarmTargets(tc, settings, { overtimeApproved, retroDone });

    // A banner about a target that just disarmed (lunch taken) or moved (clock-out
    // pushed later) is stale; clear it before evaluating the new state.
    for (const t of targets) {
      const prev = lastTargets.current[t.id];
      if (prev && (prev.armed !== t.armed || Math.abs(prev.at - t.at) >= MINUTE_MS)) dismissByTag(`alarm:${t.id}`);
      lastTargets.current[t.id] = { at: t.at, armed: t.armed };
    }

    const { fire, crossed } = dueEvents(dateKey, targets, settings.alarms, fired.current.set, now);
    if (crossed.length === 0) return;
    for (const k of crossed) fired.current.set.add(k);
    // With storage blocked (private mode, quota) alarms may repeat after a reload, which is acceptable.
    writeStored(STORAGE_PREFIX + dateKey, JSON.stringify([...fired.current.set]));

    // Every alarm banner is sticky: the chime is what grabs attention, and the banner has to
    // still be there — saying which alarm and why — when the user looks up. The next
    // threshold replaces it (same tag) and a moved/disarmed target clears it (above).
    const ctx = {
      clockIn: tc.clockIn,
      hour12: resolveHour12(settings.timeFormat),
      workMinutes: settings.workMinutes,
      lunchDeadlineMinutes: settings.lunchDeadlineMinutes,
      secondMealAfterMinutes: settings.secondMealAfterMinutes,
      now,
    };
    for (const e of fire) {
      const { kicker, title, body, tone } = describeEvent(e, ctx);
      const action =
        e.id === 'clockOut' && approveOvertime
          ? { label: ALARM_ACTIONS.approveOvertime, run: approveOvertime }
          : e.id === 'retro'
            ? { label: ALARM_ACTIONS.openRetro, run: openRetro }
            : undefined;
      alert({
        kicker,
        title,
        body,
        tone,
        sticky: true,
        chime: settings.sounds[e.kind],
        tag: `alarm:${e.id}`,
        action,
        sound: settings.sound,
        notifications: settings.notifications,
      });
    }
  }, [dateKey, tc, settings, now, overtimeApproved, retroDone, approveOvertime, openRetro]);
}
