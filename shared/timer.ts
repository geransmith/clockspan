/**
 * Pause-aware session timing, shared by the server (what a finished session logs) and the
 * client (what the countdown shows). A pause stops the focus clock without ending the session:
 * `pausedAt` is set while paused and `pausedSeconds` holds the pauses that have already ended.
 */
import { SETTING_LIMITS } from './settings.js';

/** How long a session may be planned for: the server refuses a length outside it, and the − button stops at the minimum. */
export const PLANNED_SECONDS = { min: 60, max: 8 * 3600 } as const;

/**
 * How long a break may run: the Break setting's range in seconds, so the server takes every
 * length the setting offers, and a suggested break stays inside it too.
 */
export const BREAK_SECONDS = { min: SETTING_LIMITS.breakMinutes.min * 60, max: SETTING_LIMITS.breakMinutes.max * 60 } as const;

/**
 * The shortest break kept: one ended sooner (Break pressed by mistake) is dropped, not logged.
 * The server drops it and the client's copy of the day does the same (`endBreaksAt`).
 */
export const MIN_BREAK_MS = BREAK_SECONDS.min * 1000;

export interface SessionTiming {
  startedAt: number;
  plannedSeconds: number;
  pausedSeconds: number;
  pausedAt: number | null;
}

/**
 * Focus time in ms up to `until`: `now` for a live session, `endedAt` for a finished one. A
 * paused session stops at its `pausedAt`, whatever `until` says, so its countdown and the log's
 * running row hold still. Only a live session has `pausedAt`: finish and cancel clear it, and
 * the finish route ends a paused session at its `pausedAt` itself.
 */
export function activeMs(s: Omit<SessionTiming, 'plannedSeconds'>, until: number): number {
  return Math.max(0, (s.pausedAt ?? until) - s.startedAt - s.pausedSeconds * 1000);
}

/**
 * The ended pauses once a resume at `at` folds the open pause in, rounded to whole seconds:
 * what the server stores and what the client shows before it answers. Unchanged when nothing
 * is paused.
 */
export function pausedSecondsAfter(s: Pick<SessionTiming, 'pausedAt' | 'pausedSeconds'>, at: number): number {
  return s.pausedAt == null ? s.pausedSeconds : s.pausedSeconds + Math.round((at - s.pausedAt) / 1000);
}

/**
 * The instant the planned time runs out. While paused it moves forward with `now`, so the
 * remaining time holds still and a paused timer never completes on its own.
 */
export function plannedEndAt(s: SessionTiming, now: number): number {
  return now + s.plannedSeconds * 1000 - activeMs(s, now);
}
