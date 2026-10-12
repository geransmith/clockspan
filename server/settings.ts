/**
 * A user's settings: the stored JSON merged onto the defaults on every read and every write
 * (`mergeSettings`), so a key added since the user's last save takes today's default (a save
 * stores every key, so a changed default never reaches a stored row) and nothing a client sends
 * can store a bad value. The settings router and the retention job both read them here.
 */
import type { DB } from './db.js';
import {
  ALARM_IDS,
  ALARM_LIMITS,
  DEFAULT_SETTINGS,
  normalizeLayout,
  RETENTION_LIMITS,
  SETTING_LIMITS,
  THEMES,
  TIMER_MINUTES,
  TIME_FORMATS,
  WEEKLY_MEETINGS_MAX,
  type AlarmSettings,
  type RetentionSettings,
  type Settings,
  type WeeklyMeeting,
} from '../shared/settings.js';
import { isValidDateKey } from '../shared/dates.js';
import { meetingTitle } from '../shared/text.js';
import { UID_RE } from './routes/shared.js';
import { SOUND_EVENTS, SOUND_IDS, type SoundEvent, type SoundId } from '../shared/sounds.js';
import { isOneOf, isWholeNumber } from './validate.js';

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);
const oneOf = <T extends string>(list: readonly T[], v: unknown, fallback: T): T => (isOneOf(list, v) ? v : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const whole = (v: unknown, bounds: { readonly min: number; readonly max: number }, fallback: number): number => (isWholeNumber(v, bounds) ? v : fallback);
type SwitchKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

function mergeAlarm(base: AlarmSettings, patch: unknown): AlarmSettings {
  const p = record(patch);
  if (!p) return base;
  return {
    enabled: bool(p.enabled, base.enabled),
    leadMinutes: Array.isArray(p.leadMinutes)
      ? [...new Set(p.leadMinutes.filter((n): n is number => isWholeNumber(n, ALARM_LIMITS.leadMinutes)))].sort((a, b) => b - a)
      : base.leadMinutes,
    onDue: bool(p.onDue, base.onDue),
    overdueEveryMinutes: whole(p.overdueEveryMinutes, ALARM_LIMITS.overdueEveryMinutes, base.overdueEveryMinutes),
  };
}

function mergeAlarms(base: Settings['alarms'], patch: unknown): Settings['alarms'] {
  const p = record(patch);
  if (!p) return base;
  const next = { ...base };
  for (const id of ALARM_IDS) next[id] = mergeAlarm(base[id], p[id]);
  return next;
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
    enabled: bool(p.enabled, base.enabled),
    days: whole(p.days, RETENTION_LIMITS, base.days),
  };
}

/** Button by button: a bad length keeps the one it would replace, and the count never changes. */
function mergeTimerMinutes(base: number[], patch: unknown): number[] {
  if (!Array.isArray(patch)) return base;
  const next: unknown[] = patch;
  return base.map((m, i) => whole(next[i], TIMER_MINUTES, m));
}

const ISO_DAY = { min: 1, max: 7 } as const;
const DAY_MINUTE = { min: 0, max: 24 * 60 } as const;

/**
 * The weekly meetings' parts, a list saved whole: a part that isn't whole (a uid's shape, a day from
 * 1 to 7, minutes of the day with the end after the start, `until` null or not before `since`), or
 * that starts before an earlier part of its uid ends, is dropped. Past `WEEKLY_MEETINGS_MAX` the parts
 * that ended longest ago go first, so a change, which ends one part and starts another, never loses
 * a meeting that runs on. Kept in order of `since`.
 */
function mergeMeetings(base: WeeklyMeeting[], patch: unknown): WeeklyMeeting[] {
  if (!Array.isArray(patch)) return base;
  const parts: WeeklyMeeting[] = [];
  for (const item of patch as unknown[]) {
    const m = record(item);
    if (!m || typeof m.uid !== 'string' || !UID_RE.test(m.uid) || typeof m.title !== 'string') continue;
    const weekdays = Array.isArray(m.weekdays) ? [...new Set(m.weekdays.filter((d): d is number => isWholeNumber(d, ISO_DAY)))].sort((a, b) => a - b) : [];
    const { start, end, since, until } = m;
    if (weekdays.length === 0 || !isWholeNumber(start, DAY_MINUTE) || !isWholeNumber(end, DAY_MINUTE) || end <= start) continue;
    if (!isValidDateKey(since) || !(until === null || (isValidDateKey(until) && until >= since))) continue;
    parts.push({ uid: m.uid.toLowerCase(), title: meetingTitle(m.title), weekdays, start, end, since, until });
  }
  // Each uid's latest end so far ('' before its first part, null once a part runs on).
  const ends = new Map<string, string | null>();
  const kept = parts
    .sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0))
    .filter((w) => {
      const end = ends.has(w.uid) ? ends.get(w.uid)! : '';
      if (end === null || w.since <= end) return false;
      ends.set(w.uid, w.until);
      return true;
    });
  const ended = kept.filter((w) => w.until != null).sort((a, b) => (a.until! < b.until! ? -1 : a.until! > b.until! ? 1 : 0));
  const dropped = new Set(ended.slice(0, kept.length - WEEKLY_MEETINGS_MAX));
  return kept.filter((w) => !dropped.has(w)).slice(0, WEEKLY_MEETINGS_MAX);
}

/**
 * Merge a patch onto `base` (the defaults on a read, the user's stored settings on a write),
 * validating every field. Unknown keys are dropped and an invalid value keeps `base`'s, so a
 * bad client can never corrupt settings.
 */
export function mergeSettings(base: Settings, patch: unknown): Settings {
  const p = record(patch);
  if (!p) return base;
  const limited = (key: keyof typeof SETTING_LIMITS): number => whole(p[key], SETTING_LIMITS[key], base[key]);
  const flag = (key: SwitchKey): boolean => bool(p[key], base[key]);

  const layout = Array.isArray(p.layout) ? normalizeLayout(p.layout) : base.layout;
  // Until 0.3 the sticker chart was a sheet card; a row saved then carries its choice in the
  // layout. Honour it until the user's next save writes the setting itself.
  const stickerCard =
    Array.isArray(p.layout) &&
    p.layout.some((item: unknown) => {
      const card = record(item);
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
    shortcuts: flag('shortcuts'),
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
    stickers: bool(p.stickers, stickerCard || base.stickers),
    showWeekends: flag('showWeekends'),
    clockBar: flag('clockBar'),
    recurringPerDay: limited('recurringPerDay'),
    alarms: mergeAlarms(base.alarms, p.alarms),
    layout,
    retention: mergeRetention(base.retention, p.retention),
    meetings: mergeMeetings(base.meetings, p.meetings),
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
