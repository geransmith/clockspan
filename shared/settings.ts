/**
 * Per-user settings: the shape, the defaults and the bounds. Imported by the server
 * (`mergeSettings` validates against these) and the client (first render before the real
 * settings arrive). Pure data (the one import is the sound catalog), so either side can pull it in.
 */
import type { SoundEvent, SoundId } from './sounds.js';

export const CARD_IDS = ['timeclock', 'priorities', 'timer', 'log', 'retro'] as const;
export type CardId = (typeof CARD_IDS)[number];

/** Whether a card shows until the user says otherwise; a card missing from a saved layout gets this. */
export const CARD_DEFAULT_VISIBLE: Record<CardId, boolean> = {
  timeclock: true,
  priorities: true,
  timer: true,
  log: true,
  retro: true,
};

export type AlarmId = 'lunchBy' | 'clockOut' | 'secondMeal' | 'retro';

/** How times are written: the browser locale's way, or 12-hour / 24-hour regardless. */
export const TIME_FORMATS = ['auto', '12h', '24h'] as const;
export type TimeFormat = (typeof TIME_FORMATS)[number];

export interface AlarmSettings {
  enabled: boolean;
  leadMinutes: number[];
  onDue: boolean;
  overdueEveryMinutes: number;
}

export interface RetentionSettings {
  enabled: boolean;
  days: number;
}

export interface Settings {
  workMinutes: number;
  lunchDeadlineMinutes: number;
  lunchMinutes: number;
  /** Hours *worked* after which a second meal period is due (California: 10 h). */
  secondMealAfterMinutes: number;
  timeFormat: TimeFormat;
  adjustStepMinutes: number;
  /** Rows a fresh day's priorities card starts with. */
  priorityCount: number;
  sound: boolean;
  notifications: boolean;
  keepScreenAwake: boolean;
  /** Show the per-day "Overtime approved" switch and banner action. */
  overtimeApproval: boolean;
  /** Which sound each event plays; `sound` above is the master switch over all of them. */
  sounds: Record<SoundEvent, SoundId>;
  /** Emoji bursts when a priority is ticked or the day ends. */
  celebrations: boolean;
  /** Stickers on the History calendar: one per thing a day did. Off by default. */
  stickers: boolean;
  /** Saturday and Sunday columns on the History calendar; off drops them and their stickers from the counts. */
  showWeekends: boolean;
  alarms: Record<AlarmId, AlarmSettings>;
  layout: { id: CardId; visible: boolean }[];
  /** Automatic prune of this user's days older than `days`; off by default. */
  retention: RetentionSettings;
}

/** Priority rows a day can hold; the server rejects more, the card stops offering "Add". */
export const MAX_PRIORITIES = 20;

/** Bounds for "keep the last N days", per user and for the server-wide RETENTION_DAYS. */
export const MIN_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 3650;

const DEFAULT_ALARM: AlarmSettings = { enabled: true, leadMinutes: [15, 5, 1], onDue: true, overdueEveryMinutes: 5 };
// The retrospective is one nudge before the day ends, not a deadline: no repeat by default.
const DEFAULT_RETRO_ALARM: AlarmSettings = { enabled: true, leadMinutes: [30], onDue: false, overdueEveryMinutes: 0 };

/** Frozen all the way down: both sides hand this object out as-is when there is nothing to merge. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

export const DEFAULT_SETTINGS: Settings = deepFreeze({
  workMinutes: 480,
  lunchDeadlineMinutes: 300,
  lunchMinutes: 30,
  secondMealAfterMinutes: 600,
  timeFormat: 'auto',
  adjustStepMinutes: 5,
  priorityCount: 3,
  sound: true,
  notifications: true,
  keepScreenAwake: true,
  overtimeApproval: true,
  sounds: { timer: 'triad', lead: 'taps', due: 'notes', overdue: 'double', dayDone: 'yay', priorityDone: 'none' },
  celebrations: true,
  stickers: false,
  showWeekends: true,
  alarms: { lunchBy: { ...DEFAULT_ALARM }, clockOut: { ...DEFAULT_ALARM }, secondMeal: { ...DEFAULT_ALARM }, retro: { ...DEFAULT_RETRO_ALARM } },
  layout: CARD_IDS.map((id) => ({ id, visible: CARD_DEFAULT_VISIBLE[id] })),
  retention: { enabled: false, days: 365 },
});
