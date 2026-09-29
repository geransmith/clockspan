import { useEffect, useRef } from 'react';
import { MINUTE_MS } from '../../../shared/dates.js';
import type { Settings } from '../types';
import type { TimeclockResult } from '../lib/timeclock';
import { alarmTargets, describeEvent, dueEvents, type TargetDay } from '../lib/alarms';
import { alert, dismissByTag } from '../lib/alerts';
import { ALARM_ACTIONS } from '../lib/copy';
import { resolveHour12 } from '../lib/format';
import { pruneStored, readStoredJson, writeStored } from '../lib/storage';

const STORAGE_PREFIX = 'focus:alarms:';

/** Today's fired keys; other days' are dropped so the store never grows. */
function loadFired(dateKey: string): Set<string> {
  const key = STORAGE_PREFIX + dateKey;
  pruneStored(STORAGE_PREFIX, key);
  const stored = readStoredJson(key);
  return new Set(Array.isArray(stored) ? stored.filter((k): k is string => typeof k === 'string') : []);
}

/** The day's switches (which targets are armed is `alarmTargets`) and the banner buttons. */
export interface AlarmDayState extends TargetDay {
  approveOvertime?: () => void;
  openRetro?: () => void;
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
    if (!tc || tc.clockIn == null) return;
    if (!fired.current || fired.current.date !== dateKey) fired.current = { date: dateKey, set: loadFired(dateKey) };

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
    };
    for (const e of fire) {
      const { kicker, title, body, tone } = describeEvent(e, ctx);
      const action =
        e.id === 'clockOut' && approveOvertime
          ? { label: ALARM_ACTIONS.approveOvertime, run: approveOvertime }
          : e.id === 'retro' && openRetro
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
