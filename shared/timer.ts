/**
 * Pause-aware session timing, shared by the server (what a finished session logs) and the
 * client (what the countdown shows). A pause stops the focus clock without ending the session:
 * `pausedAt` is set while paused and `pausedSeconds` holds the pauses that have already ended.
 */

export interface SessionTiming {
  startedAt: number;
  plannedSeconds: number;
  pausedSeconds: number;
  pausedAt: number | null;
}

/**
 * Focus time in ms up to `until`: `now` for a live session, `endedAt` for a finished one. A
 * session that is paused stops at its `pausedAt`, whatever `until` says, so a session finished
 * while paused is logged up to the moment the pause began.
 */
export function activeMs(s: Omit<SessionTiming, 'plannedSeconds'>, until: number): number {
  return Math.max(0, (s.pausedAt ?? until) - s.startedAt - s.pausedSeconds * 1000);
}

/**
 * The instant the planned time runs out. While paused it moves forward with `now`, so the
 * remaining time holds still and a paused timer never completes on its own.
 */
export function plannedEndAt(s: SessionTiming, now: number): number {
  return now + s.plannedSeconds * 1000 - activeMs(s, now);
}
