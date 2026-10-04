/**
 * Per-user settings: the shape, the defaults, the bounds and the layout merge. Imported by the
 * server (`mergeSettings` validates against these) and the client (first render before the real
 * settings arrive). No side effects and no runtime imports (the one import is the sound
 * catalog's types), so either side can pull it in.
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

/**
 * A layout made whole, from a saved or sent list: the cards in their order, unknown and
 * repeated ids dropped, a `visible` that isn't a boolean read as the card's default, and every
 * card the layout misses (one added in a later release) appended with its default. The server
 * runs it on every settings read and write (`mergeSettings`) and the client on every answer, so
 * a new card reaches existing users on both sides.
 */
export function normalizeLayout(raw: readonly unknown[]): { id: CardId; visible: boolean }[] {
  const seen = new Set<CardId>();
  const out: { id: CardId; visible: boolean }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { id, visible } = item as { id?: unknown; visible?: unknown };
    if (!CARD_IDS.includes(id as CardId) || seen.has(id as CardId)) continue;
    const card = id as CardId;
    seen.add(card);
    out.push({ id: card, visible: typeof visible === 'boolean' ? visible : CARD_DEFAULT_VISIBLE[card] });
  }
  for (const id of CARD_IDS) if (!seen.has(id)) out.push({ id, visible: CARD_DEFAULT_VISIBLE[id] });
  return out;
}

export type AlarmId = 'lunchBy' | 'clockOut' | 'secondMeal' | 'retro';

/** How times are written: the browser locale's way, or 12-hour / 24-hour regardless. */
export const TIME_FORMATS = ['auto', '12h', '24h'] as const;
export type TimeFormat = (typeof TIME_FORMATS)[number];

/** Light or dark: the system's choice, or one of them regardless. */
export const THEMES = ['auto', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

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
  /** Hours a week the sheet counts the days toward, in minutes; 0 hides the week line. */
  weekMinutes: number;
  timeFormat: TimeFormat;
  theme: Theme;
  adjustStepMinutes: number;
  /** The focus timer's Break button: how long a break runs, in minutes. */
  breakMinutes: number;
  /**
   * After a session finished by hand, a banner offers a break sized to it on the Pomodoro
   * technique's numbers (`client/src/lib/breaks.ts`), and the Break button offers the same
   * length. Off by default.
   */
  suggestBreaks: boolean;
  /** The focus timer's start buttons, in minutes; always three. */
  timerMinutes: number[];
  /** Rows a fresh day's priorities card starts with. */
  priorityCount: number;
  sound: boolean;
  notifications: boolean;
  keepScreenAwake: boolean;
  /**
   * Overtime applies: the per-day "Overtime approved" switch and banner action, and time past
   * the day's length shown as overtime. Off (exempt, salaried) it reads as time past the day.
   */
  overtimeApproval: boolean;
  /** The lunch deadline and second meal period rules, with their alarms. Off where they don't apply (exempt work, another state). */
  mealRules: boolean;
  /**
   * The timeclock's Lunch out and Lunch in rows while `mealRules` is off. Off hides them on a
   * day with no lunch punched; with the meal periods on they always show.
   */
  lunchPunches: boolean;
  /** Hours worked shown past the day's own tiles: the week line, the hours in History and the Clocked out sticker. */
  trackHours: boolean;
  /** Which sound each event plays; `sound` above is the master switch over all of them. */
  sounds: Record<SoundEvent, SoundId>;
  /** Emoji bursts when a priority is ticked, the day ends, the work week is reached or the next day is planned. */
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

/** A focus timer start button's length in minutes. `timerMinutes` is a list, so its bounds sit here rather than in `SETTING_LIMITS`. */
export const TIMER_MINUTES = { min: 1, max: 240 } as const;

/** Bounds for "keep the last N days", per user and for the server-wide RETENTION_DAYS. */
export const RETENTION_LIMITS = { min: 30, max: 3650 } as const;

/** The numeric settings' bounds: `mergeSettings` keeps the old value outside them, the settings inputs clamp to them. */
export const SETTING_LIMITS = {
  workMinutes: { min: 1, max: 24 * 60 },
  lunchDeadlineMinutes: { min: 1, max: 24 * 60 },
  lunchMinutes: { min: 0, max: 8 * 60 },
  secondMealAfterMinutes: { min: 1, max: 24 * 60 },
  weekMinutes: { min: 0, max: 7 * 24 * 60 },
  adjustStepMinutes: { min: 1, max: 60 },
  breakMinutes: { min: 1, max: 60 },
  priorityCount: { min: 1, max: 10 },
} as const satisfies Partial<Record<keyof Settings, { min: number; max: number }>>;

/** An alarm's warn-before minutes and its repeat while overdue (0 = no repeat). The settings chips offer values inside these. */
export const ALARM_LIMITS = {
  leadMinutes: { min: 1, max: 240 },
  overdueEveryMinutes: { min: 0, max: 120 },
} as const;

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
  weekMinutes: 40 * 60,
  timeFormat: 'auto',
  theme: 'auto',
  adjustStepMinutes: 5,
  breakMinutes: 5,
  suggestBreaks: false,
  timerMinutes: [15, 25, 50],
  priorityCount: 3,
  sound: true,
  notifications: true,
  keepScreenAwake: true,
  overtimeApproval: true,
  mealRules: true,
  lunchPunches: true,
  trackHours: true,
  sounds: {
    timer: 'triad',
    breakDone: 'taps',
    lead: 'taps',
    due: 'notes',
    overdue: 'double',
    dayDone: 'yay',
    weekDone: 'tada',
    priorityDone: 'none',
    planDone: 'none',
  },
  celebrations: true,
  stickers: false,
  showWeekends: true,
  alarms: { lunchBy: { ...DEFAULT_ALARM }, clockOut: { ...DEFAULT_ALARM }, secondMeal: { ...DEFAULT_ALARM }, retro: { ...DEFAULT_RETRO_ALARM } },
  layout: CARD_IDS.map((id) => ({ id, visible: CARD_DEFAULT_VISIBLE[id] })),
  retention: { enabled: false, days: 365 },
});
