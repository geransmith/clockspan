import { emptyDay } from '../../../shared/api.js';
import { MINUTE_MS } from '../../../shared/dates.js';
import { kindForPosition } from '../../../shared/punches.js';
import { CARD_IDS } from '../../../shared/settings.js';
import { ApiError } from '../lib/apiError';
import { REQUEST_FAILED } from '../lib/copy';
import type { DaySummary } from '../lib/stickers';
import { normalizePunches } from '../lib/timeclock';
import type { AuthInfo, Break, CancelledSession, CompletedSession, Day, Priority, PublicUser, Punch, RunningSession, Settings } from '../types';

/**
 * The plain test factories, with no React and no providers, so a lib test (which runs under
 * `node`) can import them. `hooks.tsx` re-exports them beside the provider stack.
 */

/** Monday 28 September 2026, 09:00 local time, so date keys agree in any time zone. */
export const T0 = new Date(2026, 8, 28, 9, 0).getTime();
export const TODAY = '2026-09-28';
/** The day before TODAY. */
export const YESTERDAY = '2026-09-27';
/** The midnight that starts TODAY. */
export const MIDNIGHT = new Date(2026, 8, 28).getTime();

/**
 * The settings every test starts from. Written out rather than taken from `DEFAULT_SETTINGS`,
 * so a changed default never moves a test's expectation; the type makes a missing field an error.
 */
export const TEST_SETTINGS: Settings = {
  workMinutes: 480,
  lunchDeadlineMinutes: 300,
  lunchMinutes: 30,
  secondMealAfterMinutes: 600,
  weekMinutes: 2400,
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
  alarms: {
    lunchBy: { enabled: true, leadMinutes: [15, 5, 1], onDue: true, overdueEveryMinutes: 5 },
    clockOut: { enabled: true, leadMinutes: [15, 5, 1], onDue: true, overdueEveryMinutes: 5 },
    secondMeal: { enabled: true, leadMinutes: [15, 5, 1], onDue: true, overdueEveryMinutes: 5 },
    retro: { enabled: true, leadMinutes: [30], onDue: false, overdueEveryMinutes: 0 },
  },
  layout: CARD_IDS.map((id) => ({ id, visible: true })),
  retention: { enabled: false, days: 365 },
};

export function makeSettings(patch: Partial<Settings> = {}): Settings {
  return { ...TEST_SETTINGS, ...patch };
}

/** A day's punch rows with these times from Clock in on, normalized the way the day store keeps them. */
export const punchesAt = (...at: (number | null)[]): Punch[] =>
  normalizePunches(at.map((t, position) => ({ position, kind: kindForPosition(position), at: t })));

export function makeDay(date = TODAY, patch: Partial<Day> = {}): Day {
  return { ...emptyDay(date), punches: punchesAt(), ...patch };
}

/** A priority row with text, as the card saves it once typed: not done, with a uid and added at T0. */
export function makePriority(position: number, text: string, patch: Partial<Priority> = {}): Priority {
  return { position, text, done: false, uid: `uid${position}`.padEnd(12, '0'), addedAt: T0, ...patch };
}

export function makeSession(patch: Partial<RunningSession> = {}): RunningSession {
  return {
    id: 1,
    date: TODAY,
    label: 'Write the report',
    plannedSeconds: 25 * 60,
    startedAt: T0,
    endedAt: null,
    status: 'running',
    pausedSeconds: 0,
    pausedAt: null,
    durationSeconds: null,
    priorityUid: null,
    ...patch,
  };
}

/** What `endSession` may set on the ended session. */
export type EndPatch = Partial<CompletedSession | CancelledSession>;

/** `s` as the server answers once it ended: finished after its whole plan, unless `patch` says otherwise. */
export function endSession(s: RunningSession, patch: EndPatch = {}): CompletedSession | CancelledSession {
  return { ...s, status: 'completed', endedAt: s.startedAt + s.plannedSeconds * 1000, durationSeconds: s.plannedSeconds, pausedAt: null, ...patch };
}

/** A session that ran its whole plan of `seconds` from `startedAt` and was finished. */
export function completedSession(id: number, startedAt: number, seconds: number, patch: EndPatch = {}): CompletedSession | CancelledSession {
  return endSession(makeSession({ id, label: `s${id}`, startedAt, plannedSeconds: seconds }), patch);
}

/** A five-minute break from T0 that ran its full length. */
export function makeBreak(patch: Partial<Break> = {}): Break {
  return { id: 1, date: TODAY, plannedSeconds: 5 * 60, startedAt: T0, endedAt: T0 + 5 * MINUTE_MS, ...patch };
}

/** A break `minutes` long that started `atMinutes` after T0 and ran its full length. */
export function breakAt(id: number, atMinutes: number, minutes: number, patch: Partial<Break> = {}): Break {
  const startedAt = T0 + atMinutes * MINUTE_MS;
  return makeBreak({ id, plannedSeconds: minutes * 60, startedAt, endedAt: startedAt + minutes * MINUTE_MS, ...patch });
}

/** A signed-in user: the local non-admin `sam`, unless `patch` says otherwise. */
export function makeUser(patch: Partial<PublicUser> = {}): PublicUser {
  return { id: 2, name: 'sam', username: 'sam', isAdmin: false, kind: 'local', mustChangePassword: false, ...patch };
}

/** What the server sends under AUTH_MODE=none: the default user, who is an admin. */
export const DEFAULT_USER = makeUser({ id: 1, name: 'You', username: null, kind: 'default', isAdmin: true });

/** A `GET /auth/me` answer: local sign-in, set up, and no one signed in, unless `patch` says otherwise. */
export function makeAuth(patch: Partial<AuthInfo> = {}): AuthInfo {
  return { mode: 'local', setupRequired: false, user: null, cookieSecure: false, ...patch };
}

/** A day as the History calendar holds it (`daySummaryOf`): no punch set and nothing done. */
export function makeSummary(date: string, patch: Partial<DaySummary> = {}): DaySummary {
  return { date, punches: punchesAt(), focusSeconds: 0, focusSessions: 0, prioritiesDone: 0, prioritiesTotal: 0, retroAt: null, workMinutes: null, ...patch };
}

/** A promise the test settles by hand, for answers that must arrive in a chosen order. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** An API failure the way `request()` throws one: a status, and the body for a 409. */
export function apiError(status: number, body?: unknown): ApiError {
  return new ApiError(status, REQUEST_FAILED(status), body);
}
