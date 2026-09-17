import { useEffect, useRef } from 'react';
import type { Settings } from '../types';
import { secondMealApplies, type TimeclockResult } from '../lib/timeclock';
import { describeEvent, dueEvents, type AlarmTarget } from '../lib/alarms';
import { alert, dismissByTag } from '../lib/alerts';

const STORAGE_PREFIX = 'focus:alarms:';

function loadFired(dateKey: string): Set<string> {
  try {
    // Prune other days so the store never grows.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(STORAGE_PREFIX) && k !== STORAGE_PREFIX + dateKey) localStorage.removeItem(k);
    }
    const raw = localStorage.getItem(STORAGE_PREFIX + dateKey);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveFired(dateKey: string, fired: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + dateKey, JSON.stringify([...fired]));
  } catch {
    // Private mode / quota: alarms may repeat after a reload, which is acceptable.
  }
}

/**
 * App-level alarm engine for today's timeclock. Runs every tick; the pure scheduler
 * decides what is due and the fired-set (persisted per day) prevents repeats.
 * `overtimeApproved` silences the clock-out target only: meal periods are still required
 * on an overtime day (California Labor Code §512), so lunch and second meal stay armed.
 */
export function useAlarms(
  dateKey: string,
  tc: TimeclockResult | null,
  settings: Settings,
  now: number,
  overtimeApproved: boolean,
  onApproveOvertime?: () => void,
): void {
  const fired = useRef<{ date: string; set: Set<string> } | null>(null);
  const lastTargets = useRef<Record<string, { at: number; armed: boolean }>>({});

  useEffect(() => {
    if (!tc || tc.clockIn == null) return;
    if (!fired.current || fired.current.date !== dateKey) fired.current = { date: dateKey, set: loadFired(dateKey) };

    const targets: AlarmTarget[] = [
      { id: 'lunchBy', at: tc.lunchBy ?? 0, armed: tc.lunchBy != null && tc.lunchStatus !== 'taken' && tc.state !== 'done' },
      // Clock-out is only a fixed instant while working; on a break it drifts.
      { id: 'clockOut', at: tc.clockOutAt ?? 0, armed: tc.clockOutAt != null && tc.state === 'working' && !overtimeApproved },
      { id: 'secondMeal', at: tc.secondMealBy ?? 0, armed: secondMealApplies(tc, settings, overtimeApproved) },
    ];

    // A banner about a target that just disarmed (lunch taken) or moved (clock-out
    // pushed later) is stale; clear it before evaluating the new state.
    for (const t of targets) {
      const prev = lastTargets.current[t.id];
      if (prev && (prev.armed !== t.armed || Math.abs(prev.at - t.at) >= 60_000)) dismissByTag(`alarm:${t.id}`);
      lastTargets.current[t.id] = { at: t.at, armed: t.armed };
    }

    const { fire, crossed } = dueEvents(dateKey, targets, settings.alarms, fired.current.set, now);
    if (crossed.length === 0) return;
    for (const k of crossed) fired.current.set.add(k);
    saveFired(dateKey, fired.current.set);

    // Every alarm banner is sticky: the chime is what grabs attention, and the banner has to
    // still be there — saying which alarm and why — when the user looks up. The next
    // threshold replaces it (same tag) and a moved/disarmed target clears it (above).
    const ctx = {
      clockIn: tc.clockIn,
      workMinutes: settings.workMinutes,
      lunchDeadlineMinutes: settings.lunchDeadlineMinutes,
      secondMealAfterMinutes: settings.secondMealAfterMinutes,
    };
    for (const e of fire) {
      const { kicker, title, body, tone } = describeEvent(e, ctx);
      alert({
        kicker,
        title,
        body,
        tone,
        sticky: true,
        chime: e.kind,
        tag: `alarm:${e.id}`,
        action: e.id === 'clockOut' && onApproveOvertime ? { label: 'Overtime approved', run: onApproveOvertime } : undefined,
        sound: settings.sound,
        notifications: settings.notifications,
      });
    }
  }, [dateKey, tc, settings, now, overtimeApproved, onApproveOvertime]);
}
