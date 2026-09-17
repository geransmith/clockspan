import { Router } from 'express';
import type { DB } from '../db.js';
import { currentUser } from '../auth/middleware.js';

export const CARD_IDS = ['timeclock', 'priorities', 'timer', 'log'] as const;
export type CardId = (typeof CARD_IDS)[number];

export interface AlarmSettings {
  enabled: boolean;
  leadMinutes: number[];
  onDue: boolean;
  overdueEveryMinutes: number;
}

export interface Settings {
  workMinutes: number;
  lunchDeadlineMinutes: number;
  lunchMinutes: number;
  /** Hours *worked* after which a second meal period is due (California: 10 h). */
  secondMealAfterMinutes: number;
  adjustStepMinutes: number;
  priorityCount: number;
  sound: boolean;
  notifications: boolean;
  keepScreenAwake: boolean;
  /** Show the per-day "Overtime approved" switch and banner action. */
  overtimeApproval: boolean;
  alarms: { lunchBy: AlarmSettings; clockOut: AlarmSettings; secondMeal: AlarmSettings };
  layout: { id: CardId; visible: boolean }[];
}

const DEFAULT_ALARM: AlarmSettings = { enabled: true, leadMinutes: [15, 5, 1], onDue: true, overdueEveryMinutes: 5 };

export const DEFAULT_SETTINGS: Settings = {
  workMinutes: 480,
  lunchDeadlineMinutes: 300,
  lunchMinutes: 30,
  secondMealAfterMinutes: 600,
  adjustStepMinutes: 5,
  priorityCount: 3,
  sound: true,
  notifications: true,
  keepScreenAwake: true,
  overtimeApproval: true,
  alarms: { lunchBy: { ...DEFAULT_ALARM }, clockOut: { ...DEFAULT_ALARM }, secondMeal: { ...DEFAULT_ALARM } },
  layout: CARD_IDS.map((id) => ({ id, visible: true })),
};

export const MAX_PRIORITIES = 20;

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

function mergeAlarm(base: AlarmSettings, patch: unknown): AlarmSettings {
  if (!patch || typeof patch !== 'object') return base;
  const p = patch as Record<string, unknown>;
  return {
    enabled: isBool(p.enabled) ? p.enabled : base.enabled,
    leadMinutes: Array.isArray(p.leadMinutes)
      ? [...new Set(p.leadMinutes.filter((n): n is number => isInt(n, 1, 240)))].sort((a, b) => b - a)
      : base.leadMinutes,
    onDue: isBool(p.onDue) ? p.onDue : base.onDue,
    overdueEveryMinutes: isInt(p.overdueEveryMinutes, 0, 120) ? p.overdueEveryMinutes : base.overdueEveryMinutes,
  };
}

/**
 * Merge a stored/patch object onto defaults, validating every field. Unknown keys are
 * dropped and invalid values fall back, so a bad client can never corrupt settings.
 */
export function mergeSettings(base: Settings, patch: unknown): Settings {
  if (!patch || typeof patch !== 'object') return base;
  const p = patch as Record<string, unknown>;
  const alarms = (p.alarms && typeof p.alarms === 'object' ? p.alarms : {}) as Record<string, unknown>;

  let layout = base.layout;
  if (Array.isArray(p.layout)) {
    const seen = new Set<CardId>();
    const next: Settings['layout'] = [];
    for (const item of p.layout) {
      if (!item || typeof item !== 'object') continue;
      const { id, visible } = item as Record<string, unknown>;
      if (!CARD_IDS.includes(id as CardId) || seen.has(id as CardId)) continue;
      seen.add(id as CardId);
      next.push({ id: id as CardId, visible: isBool(visible) ? visible : true });
    }
    // Any card the client omitted (e.g. added after they last saved) is appended visible.
    for (const id of CARD_IDS) if (!seen.has(id)) next.push({ id, visible: true });
    layout = next;
  }

  return {
    workMinutes: isInt(p.workMinutes, 1, 24 * 60) ? p.workMinutes : base.workMinutes,
    lunchDeadlineMinutes: isInt(p.lunchDeadlineMinutes, 1, 24 * 60) ? p.lunchDeadlineMinutes : base.lunchDeadlineMinutes,
    lunchMinutes: isInt(p.lunchMinutes, 0, 8 * 60) ? p.lunchMinutes : base.lunchMinutes,
    secondMealAfterMinutes: isInt(p.secondMealAfterMinutes, 1, 24 * 60) ? p.secondMealAfterMinutes : base.secondMealAfterMinutes,
    adjustStepMinutes: isInt(p.adjustStepMinutes, 1, 60) ? p.adjustStepMinutes : base.adjustStepMinutes,
    priorityCount: isInt(p.priorityCount, 1, 10) ? p.priorityCount : base.priorityCount,
    sound: isBool(p.sound) ? p.sound : base.sound,
    notifications: isBool(p.notifications) ? p.notifications : base.notifications,
    keepScreenAwake: isBool(p.keepScreenAwake) ? p.keepScreenAwake : base.keepScreenAwake,
    overtimeApproval: isBool(p.overtimeApproval) ? p.overtimeApproval : base.overtimeApproval,
    alarms: {
      lunchBy: mergeAlarm(base.alarms.lunchBy, alarms.lunchBy),
      clockOut: mergeAlarm(base.alarms.clockOut, alarms.clockOut),
      secondMeal: mergeAlarm(base.alarms.secondMeal, alarms.secondMeal),
    },
    layout,
  };
}

export function loadSettings(db: DB, userId: number): Settings {
  const row = db.prepare(`SELECT json FROM settings WHERE user_id = ?`).get(userId) as { json: string } | undefined;
  if (!row) return DEFAULT_SETTINGS;
  try {
    return mergeSettings(DEFAULT_SETTINGS, JSON.parse(row.json));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function settingsRouter(db: DB): Router {
  const r = Router();

  r.get('/', (req, res) => {
    res.json(loadSettings(db, currentUser(req).id));
  });

  r.put('/', (req, res) => {
    const user = currentUser(req);
    const next = mergeSettings(loadSettings(db, user.id), req.body);
    db.prepare(
      `INSERT INTO settings (user_id, json) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET json = excluded.json`,
    ).run(user.id, JSON.stringify(next));
    res.json(next);
  });

  // Settings are stored sparse and merged onto DEFAULT_SETTINGS on every read, so dropping the
  // row is the reset. The response is what the next GET will serve.
  r.delete('/', (req, res) => {
    db.prepare(`DELETE FROM settings WHERE user_id = ?`).run(currentUser(req).id);
    res.json(DEFAULT_SETTINGS);
  });

  return r;
}
