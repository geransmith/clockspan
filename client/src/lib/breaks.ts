import { MINUTE_MS } from '../../../shared/dates.js';
import { MIN_BREAK_MS } from '../../../shared/timer.js';
import type { Break, Session } from '../types';

/**
 * The break a focus session earns, on the Pomodoro technique's numbers: 25 minutes of focus
 * earn 5 of rest, and every fourth session in a row earns a long break of 15 to 30 minutes.
 * Sized to the work rather than fixed, so a 50-minute session earns 10 and a 15-minute one 3.
 */

/** A break is a fifth of the focus it follows (25 → 5). */
export const BREAK_RATIO = 5;

/** Sessions to a set; the set's last one earns the long break. */
export const SET_SIZE = 4;

/** Pomodoro's longest break: past it, a very long session doesn't earn an hour off. */
export const MAX_BREAK_MINUTES = 30;

/**
 * Pomodoro's shortest long break. A gap this long between two sessions was a long break
 * already (lunch, a meeting, or the long break itself), so the count starts over after it.
 */
export const SET_GAP_MINUTES = 15;

/** Under a minute of focus is a false start: it earns no break and isn't one of a set. */
export const MIN_FOCUS_SECONDS = 60;

export interface BreakSuggestion {
  /** The session the break follows. */
  sessionId: number;
  minutes: number;
  /** The set's last session: the long break, sized on the whole set. */
  long: boolean;
  /** Where the latest session sits in its set, 1 to `SET_SIZE`. */
  position: number;
  /** The focus the break is sized on: the latest session's, or the set's for a long break. */
  focusSeconds: number;
}

/** Seconds of rest a logged break holds at `now`: so far while it runs, its whole length once over. */
export function breakSeconds(b: Break, now: number): number {
  return Math.max(0, Math.round((Math.min(now, b.endedAt) - b.startedAt) / 1000));
}

/**
 * A day's breaks once `at` ends the one running then (End break, the next break, a focus
 * session starting): cut short at `at`, or dropped if it ran under a minute. The server does
 * the same, so the log shows it before the next refresh.
 */
export function endBreaksAt(breaks: readonly Break[], at: number): Break[] {
  return breaks.flatMap((b) => (b.endedAt <= at ? [b] : at - b.startedAt < MIN_BREAK_MS ? [] : [{ ...b, endedAt: at }]));
}

/** The break running at `now` among a day's breaks (by start): the latest one still ahead of its end. */
export function runningBreak(breaks: readonly Break[], now: number): Break | null {
  const last = breaks.at(-1);
  return last && last.endedAt > now ? last : null;
}

function breakMinutes(focusSeconds: number): number {
  return Math.min(MAX_BREAK_MINUTES, Math.max(1, Math.round(focusSeconds / 60 / BREAK_RATIO)));
}

/**
 * The break the day's latest completed session earns, from its sessions in any order; null
 * with none completed (false starts aside). Sessions are in a row while each starts less than `SET_GAP_MINUTES`
 * after the one before ended, so a skipped long break doesn't reset the count and a taken one
 * does.
 */
export function suggestBreak(sessions: readonly Session[]): BreakSuggestion | null {
  const done = sessions
    .filter((s): s is Session & { durationSeconds: number } => s.status === 'completed' && (s.durationSeconds ?? 0) >= MIN_FOCUS_SECONDS)
    .sort((a, b) => a.startedAt - b.startedAt);
  const last = done.at(-1);
  if (!last) return null;
  let first = done.length - 1;
  // Every completed row has an end; the type allows none, and a row without one ends the run.
  while (first > 0 && done[first]!.startedAt - (done[first - 1]!.endedAt ?? -Infinity) < SET_GAP_MINUTES * MINUTE_MS) first--;
  const position = ((done.length - first - 1) % SET_SIZE) + 1;
  const long = position === SET_SIZE;
  const focusSeconds = (long ? done.slice(-SET_SIZE) : [last]).reduce((sum, s) => sum + s.durationSeconds, 0);
  return { sessionId: last.id, minutes: breakMinutes(focusSeconds), long, position, focusSeconds };
}
