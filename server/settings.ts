/**
 * A user's settings: the stored JSON merged onto the defaults on every read and every write
 * (`mergeSettings`), so a key a user never saved takes today's default and nothing a client
 * sends can store a bad value. The settings router and the retention job both read them here.
 */
import type { DB } from './db.js';
import {
  ALARM_LIMITS,
  DEFAULT_SETTINGS,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  normalizeLayout,
  SETTING_LIMITS,
  THEMES,
  TIMER_MINUTES,
  TIME_FORMATS,
  type AlarmSettings,
  type RetentionSettings,
  type Settings,
  type Theme,
  type TimeFormat,
} from '../shared/settings.js';
import { SOUND_EVENTS, SOUND_IDS, type SoundEvent, type SoundId } from '../shared/sounds.js';

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

function mergeAlarm(base: AlarmSettings, patch: unknown): AlarmSettings {
  if (!patch || typeof patch !== 'object') return base;
  const p = patch as Record<string, unknown>;
  return {
    enabled: isBool(p.enabled) ? p.enabled : base.enabled,
    leadMinutes: Array.isArray(p.leadMinutes)
      ? [...new Set(p.leadMinutes.filter((n): n is number => isInt(n, ALARM_LIMITS.leadMinutes.min, ALARM_LIMITS.leadMinutes.max)))].sort((a, b) => b - a)
      : base.leadMinutes,
    onDue: isBool(p.onDue) ? p.onDue : base.onDue,
    overdueEveryMinutes: isInt(p.overdueEveryMinutes, ALARM_LIMITS.overdueEveryMinutes.min, ALARM_LIMITS.overdueEveryMinutes.max)
      ? p.overdueEveryMinutes
      : base.overdueEveryMinutes,
  };
}

function mergeSounds(base: Record<SoundEvent, SoundId>, patch: unknown): Record<SoundEvent, SoundId> {
  if (!patch || typeof patch !== 'object') return base;
  const p = patch as Record<string, unknown>;
  const next = { ...base };
  for (const event of SOUND_EVENTS) if (SOUND_IDS.includes(p[event] as SoundId)) next[event] = p[event] as SoundId;
  return next;
}

function mergeRetention(base: RetentionSettings, patch: unknown): RetentionSettings {
  if (!patch || typeof patch !== 'object') return base;
  const p = patch as Record<string, unknown>;
  return {
    enabled: isBool(p.enabled) ? p.enabled : base.enabled,
    days: isInt(p.days, MIN_RETENTION_DAYS, MAX_RETENTION_DAYS) ? p.days : base.days,
  };
}

/** Button by button: a bad length keeps the one it would replace, and the count never changes. */
function mergeTimerMinutes(base: number[], patch: unknown): number[] {
  if (!Array.isArray(patch)) return base;
  const next: unknown[] = patch;
  return base.map((m, i) => {
    const v = next[i];
    return isInt(v, TIMER_MINUTES.min, TIMER_MINUTES.max) ? v : m;
  });
}

/**
 * Merge a stored/patch object onto defaults, validating every field. Unknown keys are
 * dropped and invalid values fall back, so a bad client can never corrupt settings.
 */
export function mergeSettings(base: Settings, patch: unknown): Settings {
  if (!patch || typeof patch !== 'object') return base;
  const p = patch as Record<string, unknown>;
  const alarms = (p.alarms && typeof p.alarms === 'object' ? p.alarms : {}) as Record<string, unknown>;
  const limited = (key: keyof typeof SETTING_LIMITS): number => {
    const v = p[key];
    return isInt(v, SETTING_LIMITS[key].min, SETTING_LIMITS[key].max) ? v : base[key];
  };

  const layout = Array.isArray(p.layout) ? normalizeLayout(p.layout) : base.layout;
  // Until 0.3 the sticker chart was a sheet card; a row saved then carries its choice in the
  // layout. Honour it until the user's next save writes the setting itself.
  const stickerCard =
    Array.isArray(p.layout) &&
    (p.layout as unknown[]).some((item) => {
      const card = item as { id?: unknown; visible?: unknown } | null;
      return card?.id === 'stickers' && card.visible === true;
    });

  return {
    workMinutes: limited('workMinutes'),
    lunchDeadlineMinutes: limited('lunchDeadlineMinutes'),
    lunchMinutes: limited('lunchMinutes'),
    secondMealAfterMinutes: limited('secondMealAfterMinutes'),
    weekMinutes: limited('weekMinutes'),
    timeFormat: TIME_FORMATS.includes(p.timeFormat as TimeFormat) ? (p.timeFormat as TimeFormat) : base.timeFormat,
    theme: THEMES.includes(p.theme as Theme) ? (p.theme as Theme) : base.theme,
    adjustStepMinutes: limited('adjustStepMinutes'),
    breakMinutes: limited('breakMinutes'),
    timerMinutes: mergeTimerMinutes(base.timerMinutes, p.timerMinutes),
    priorityCount: limited('priorityCount'),
    sound: isBool(p.sound) ? p.sound : base.sound,
    notifications: isBool(p.notifications) ? p.notifications : base.notifications,
    keepScreenAwake: isBool(p.keepScreenAwake) ? p.keepScreenAwake : base.keepScreenAwake,
    overtimeApproval: isBool(p.overtimeApproval) ? p.overtimeApproval : base.overtimeApproval,
    mealRules: isBool(p.mealRules) ? p.mealRules : base.mealRules,
    trackHours: isBool(p.trackHours) ? p.trackHours : base.trackHours,
    sounds: mergeSounds(base.sounds, p.sounds),
    celebrations: isBool(p.celebrations) ? p.celebrations : base.celebrations,
    stickers: isBool(p.stickers) ? p.stickers : stickerCard || base.stickers,
    showWeekends: isBool(p.showWeekends) ? p.showWeekends : base.showWeekends,
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
