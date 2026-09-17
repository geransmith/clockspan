import { Router } from 'express';
import type { DB } from '../db.js';
import { currentUser } from '../auth/middleware.js';
import {
  CARD_DEFAULT_VISIBLE,
  CARD_IDS,
  DEFAULT_SETTINGS,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  TIME_FORMATS,
  type AlarmSettings,
  type CardId,
  type RetentionSettings,
  type Settings,
  type TimeFormat,
} from '../../shared/settings.js';

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

function mergeRetention(base: RetentionSettings, patch: unknown): RetentionSettings {
  if (!patch || typeof patch !== 'object') return base;
  const p = patch as Record<string, unknown>;
  return {
    enabled: isBool(p.enabled) ? p.enabled : base.enabled,
    days: isInt(p.days, MIN_RETENTION_DAYS, MAX_RETENTION_DAYS) ? p.days : base.days,
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
  // Until 0.3 the sticker chart was a sheet card; a row saved then carries its choice in the
  // layout. Honour it until the user's next save writes the setting itself.
  let stickers = base.stickers;
  if (Array.isArray(p.layout)) {
    const seen = new Set<CardId>();
    const next: Settings['layout'] = [];
    for (const item of p.layout) {
      if (!item || typeof item !== 'object') continue;
      const { id, visible } = item as Record<string, unknown>;
      if (id === 'stickers' && visible === true) stickers = true;
      if (!CARD_IDS.includes(id as CardId) || seen.has(id as CardId)) continue;
      seen.add(id as CardId);
      next.push({ id: id as CardId, visible: isBool(visible) ? visible : CARD_DEFAULT_VISIBLE[id as CardId] });
    }
    // Any card the client omitted (e.g. added after they last saved) is appended with its default.
    for (const id of CARD_IDS) if (!seen.has(id)) next.push({ id, visible: CARD_DEFAULT_VISIBLE[id] });
    layout = next;
  }

  return {
    workMinutes: isInt(p.workMinutes, 1, 24 * 60) ? p.workMinutes : base.workMinutes,
    lunchDeadlineMinutes: isInt(p.lunchDeadlineMinutes, 1, 24 * 60) ? p.lunchDeadlineMinutes : base.lunchDeadlineMinutes,
    lunchMinutes: isInt(p.lunchMinutes, 0, 8 * 60) ? p.lunchMinutes : base.lunchMinutes,
    secondMealAfterMinutes: isInt(p.secondMealAfterMinutes, 1, 24 * 60) ? p.secondMealAfterMinutes : base.secondMealAfterMinutes,
    timeFormat: TIME_FORMATS.includes(p.timeFormat as TimeFormat) ? (p.timeFormat as TimeFormat) : base.timeFormat,
    adjustStepMinutes: isInt(p.adjustStepMinutes, 1, 60) ? p.adjustStepMinutes : base.adjustStepMinutes,
    priorityCount: isInt(p.priorityCount, 1, 10) ? p.priorityCount : base.priorityCount,
    sound: isBool(p.sound) ? p.sound : base.sound,
    notifications: isBool(p.notifications) ? p.notifications : base.notifications,
    keepScreenAwake: isBool(p.keepScreenAwake) ? p.keepScreenAwake : base.keepScreenAwake,
    overtimeApproval: isBool(p.overtimeApproval) ? p.overtimeApproval : base.overtimeApproval,
    celebrations: isBool(p.celebrations) ? p.celebrations : base.celebrations,
    stickers: isBool(p.stickers) ? p.stickers : stickers,
    alarms: {
      lunchBy: mergeAlarm(base.alarms.lunchBy, alarms.lunchBy),
      clockOut: mergeAlarm(base.alarms.clockOut, alarms.clockOut),
      secondMeal: mergeAlarm(base.alarms.secondMeal, alarms.secondMeal),
      retro: mergeAlarm(base.alarms.retro, alarms.retro),
    },
    layout,
    retention: mergeRetention(base.retention, p.retention),
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
