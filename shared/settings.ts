/**
 * Per-user settings: the shape, the defaults, the bounds and the layout merge. Imported by both
 * sides; no side effects and no runtime imports (the one import is the sound catalog's types),
 * so either side can pull it in.
 */
import type { SoundEvent, SoundId } from './sounds.js';

export const CARD_IDS = ['timeclock', 'priorities', 'timer', 'log', 'retro'] as const;
export type CardId = (typeof CARD_IDS)[number];

/** The sheet's two columns on a wide screen. */
export const CARD_SIDES = ['left', 'right'] as const;
export type CardSide = (typeof CARD_SIDES)[number];

/**
 * The column each card starts in: the day's plan on the left, the work and the look back on
 * the right. A card added to CARD_IDS without one is a type error.
 */
export const DEFAULT_SIDE: Readonly<Record<CardId, CardSide>> = Object.freeze({
  timeclock: 'left',
  priorities: 'left',
  timer: 'right',
  log: 'right',
  retro: 'right',
});

/**
 * A layout made whole, from a saved or sent list: the cards in their order, unknown and
 * repeated ids dropped, a `visible` that isn't a boolean read as shown, a `side` that isn't a
 * column read as the card's default (a layout saved before the columns has none), and every card
 * the layout misses (one added in a later release) appended, shown, in its default column. The
 * server runs it on every settings read and write (`mergeSettings`) and the client on every
 * answer, so a new card or field reaches existing users on both sides.
 */
export function normalizeLayout(raw: readonly unknown[]): Settings['layout'] {
  const seen = new Set<CardId>();
  const out: Settings['layout'] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { id, visible, side } = item as { id?: unknown; visible?: unknown; side?: unknown };
    const card = CARD_IDS.find((c) => c === id);
    if (!card || seen.has(card)) continue;
    seen.add(card);
    out.push({ id: card, visible: typeof visible === 'boolean' ? visible : true, side: CARD_SIDES.find((s) => s === side) ?? DEFAULT_SIDE[card] });
  }
  for (const id of CARD_IDS) if (!seen.has(id)) out.push({ id, visible: true, side: DEFAULT_SIDE[id] });
  return out;
}

export const ALARM_IDS = ['lunchBy', 'clockOut', 'secondMeal', 'retro'] as const;
export type AlarmId = (typeof ALARM_IDS)[number];

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
  /** Minutes *worked* after which a second meal period is due (California: 10 h). */
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
   * length.
   */
  suggestBreaks: boolean;
  /** The focus timer's start buttons, in minutes; always three. */
  timerMinutes: number[];
  /** Rows every day's priorities card shows at least (free rows pad it). */
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
   * The timeclock's Lunch out and Lunch in rows, and the Lunch taken sticker, while `mealRules`
   * is off. Off hides the rows on a day with no lunch punched and drops the sticker; with the
   * meal periods on, both stay.
   */
  lunchPunches: boolean;
  /** Hours worked shown past the day's own tiles: the week line, the hours in History and the Clocked out sticker. */
  trackHours: boolean;
  /** Which sound each event plays; `sound` above is the master switch over all of them. */
  sounds: Record<SoundEvent, SoundId>;
  /** Emoji bursts when a priority is ticked, the day ends, the work week is reached or the next day is planned. */
  celebrations: boolean;
  /** Stickers on the History calendar: one per thing a day did. */
  stickers: boolean;
  /**
   * Saturday and Sunday columns on the History calendar. Off drops them and their stickers from
   * the counts, and Plan tomorrow then lands on the next weekday.
   */
  showWeekends: boolean;
  /**
   * The Board page, for tasks that aren't for today, and its button in the header, and with them
   * the categories and recurring priorities (Settings → Board, the morning offer).
   */
  board: boolean;
  /** Today's clock in, lunch deadline and clock out time in a row above the board's columns. */
  clockBar: boolean;
  /** Recurring rows the morning offer ticks; more can be ticked. */
  recurringPerDay: number;
  alarms: Record<AlarmId, AlarmSettings>;
  /**
   * The sheet's cards in order. `side` is the card's column while the sheet has two (a wide
   * screen); one column shows them all in this order.
   */
  layout: { id: CardId; visible: boolean; side: CardSide }[];
  /** Automatic prune of this user's days older than `days`. */
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
  recurringPerDay: { min: 1, max: 10 },
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
  board: false,
  clockBar: true,
  recurringPerDay: 3,
  alarms: { lunchBy: { ...DEFAULT_ALARM }, clockOut: { ...DEFAULT_ALARM }, secondMeal: { ...DEFAULT_ALARM }, retro: { ...DEFAULT_RETRO_ALARM } },
  layout: normalizeLayout([]),
  retention: { enabled: false, days: 365 },
});
