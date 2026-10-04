/**
 * A user's settings: the stored JSON merged onto the defaults on every read and every write
 * (`mergeSettings`), so a key added since the user's last save takes today's default (a save
 * stores every key, so a changed default never reaches a stored row) and nothing a client sends
 * can store a bad value. The settings router and the retention job both read them here.
 */
import type { DB } from './db.js';
import {
  ALARM_LIMITS,
  DEFAULT_SETTINGS,
  normalizeLayout,
  RETENTION_LIMITS,
  SETTING_LIMITS,
  THEMES,
  TIMER_MINUTES,
  TIME_FORMATS,
  type AlarmSettings,
  type RetentionSettings,
  type Settings,
} from '../shared/settings.js';
import { SOUND_EVENTS, SOUND_IDS, type SoundEvent, type SoundId } from '../shared/sounds.js';
import { isWholeNumber } from './validate.js';

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);
const oneOf = <T extends string>(list: readonly T[], v: unknown, fallback: T): T => (list.includes(v as T) ? (v as T) : fallback);
type SwitchKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

function mergeAlarm(base: AlarmSettings, patch: unknown): AlarmSettings {
  const p = record(patch);
  if (!p) return base;
  return {
    enabled: isBool(p.enabled) ? p.enabled : base.enabled,
    leadMinutes: Array.isArray(p.leadMinutes)
      ? [...new Set(p.leadMinutes.filter((n): n is number => isWholeNumber(n, ALARM_LIMITS.leadMinutes)))].sort((a, b) => b - a)
      : base.leadMinutes,
    onDue: isBool(p.onDue) ? p.onDue : base.onDue,
    overdueEveryMinutes: isWholeNumber(p.overdueEveryMinutes, ALARM_LIMITS.overdueEveryMinutes) ? p.overdueEveryMinutes : base.overdueEveryMinutes,
  };
}

function mergeSounds(base: Record<SoundEvent, SoundId>, patch: unknown): Record<SoundEvent, SoundId> {
  const p = record(patch);
  if (!p) return base;
  const next = { ...base };
  for (const event of SOUND_EVENTS) next[event] = oneOf(SOUND_IDS, p[event], next[event]);
  return next;
}

function mergeRetention(base: RetentionSettings, patch: unknown): RetentionSettings {
  const p = record(patch);
  if (!p) return base;
  return {
    enabled: isBool(p.enabled) ? p.enabled : base.enabled,
    days: isWholeNumber(p.days, RETENTION_LIMITS) ? p.days : base.days,
  };
}

/** Button by button: a bad length keeps the one it would replace, and the count never changes. */
function mergeTimerMinutes(base: number[], patch: unknown): number[] {
  if (!Array.isArray(patch)) return base;
  const next: unknown[] = patch;
  return base.map((m, i) => {
    const v = next[i];
    return isWholeNumber(v, TIMER_MINUTES) ? v : m;
  });
}

/**
 * Merge a patch onto `base` (the defaults on a read, the user's stored settings on a write),
 * validating every field. Unknown keys are dropped and an invalid value keeps `base`'s, so a
 * bad client can never corrupt settings.
 */
export function mergeSettings(base: Settings, patch: unknown): Settings {
  const p = record(patch);
  if (!p) return base;
  const alarms = record(p.alarms) ?? {};
  const limited = (key: keyof typeof SETTING_LIMITS): number => {
    const v = p[key];
    return isWholeNumber(v, SETTING_LIMITS[key]) ? v : base[key];
  };
  const flag = (key: SwitchKey): boolean => {
    const v = p[key];
    return isBool(v) ? v : base[key];
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
    timeFormat: oneOf(TIME_FORMATS, p.timeFormat, base.timeFormat),
    theme: oneOf(THEMES, p.theme, base.theme),
    adjustStepMinutes: limited('adjustStepMinutes'),
    breakMinutes: limited('breakMinutes'),
    suggestBreaks: flag('suggestBreaks'),
    timerMinutes: mergeTimerMinutes(base.timerMinutes, p.timerMinutes),
    priorityCount: limited('priorityCount'),
    sound: flag('sound'),
    notifications: flag('notifications'),
    keepScreenAwake: flag('keepScreenAwake'),
    overtimeApproval: flag('overtimeApproval'),
    mealRules: flag('mealRules'),
    lunchPunches: flag('lunchPunches'),
    trackHours: flag('trackHours'),
    sounds: mergeSounds(base.sounds, p.sounds),
    celebrations: flag('celebrations'),
    stickers: isBool(p.stickers) ? p.stickers : stickerCard || base.stickers,
    showWeekends: flag('showWeekends'),
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
