/**
 * Per-user settings: the shape, the defaults and the bounds. Imported by the server
 * (`mergeSettings` validates against these) and the client (first render before the real
 * settings arrive). Pure data, no imports, so either side can pull it in.
 */

export const CARD_IDS = ['timeclock', 'priorities', 'timer', 'log', 'retro'] as const;
export type CardId = (typeof CARD_IDS)[number];

export type AlarmId = 'lunchBy' | 'clockOut' | 'secondMeal' | 'retro';

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
  adjustStepMinutes: number;
  /** Rows a fresh day's priorities card starts with. */
  priorityCount: number;
  sound: boolean;
  notifications: boolean;
  keepScreenAwake: boolean;
  /** Show the per-day "Overtime approved" switch and banner action. */
  overtimeApproval: boolean;
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
  alarms: { lunchBy: { ...DEFAULT_ALARM }, clockOut: { ...DEFAULT_ALARM }, secondMeal: { ...DEFAULT_ALARM }, retro: { ...DEFAULT_RETRO_ALARM } },
  layout: CARD_IDS.map((id) => ({ id, visible: true })),
  retention: { enabled: false, days: 365 },
};
