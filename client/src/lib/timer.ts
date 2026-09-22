import { activeMs, plannedEndAt, type SessionTiming } from '../../../shared/timer.js';

export { activeMs };

/**
 * A pause is a break, not a parking spot. One left this long was forgotten: the client
 * finishes the session, and the server logs the focus before the pause either way.
 */
export const PAUSE_LIMIT_SECONDS = 3600;

export interface TimerView {
  /** Focus seconds so far; pauses excluded. */
  elapsedSeconds: number;
  /** Seconds left; 0 once the planned time is used up. */
  remainingSeconds: number;
  /** 0..1 */
  progress: number;
  /** When the planned time runs out; moves forward with `now` while paused. */
  endAt: number;
  paused: boolean;
  /** How long the current pause has lasted; 0 while counting. */
  pausedForSeconds: number;
}

/** What the countdown shows for a running session at `now`; derived every tick, never counted. */
export function timerView(s: SessionTiming, now: number): TimerView {
  const endAt = plannedEndAt(s, now);
  const elapsedSeconds = Math.floor(activeMs(s, now) / 1000);
  return {
    elapsedSeconds,
    remainingSeconds: Math.max(0, Math.ceil((endAt - now) / 1000)),
    progress: Math.min(1, elapsedSeconds / s.plannedSeconds),
    endAt,
    paused: s.pausedAt != null,
    pausedForSeconds: s.pausedAt != null ? Math.max(0, Math.floor((now - s.pausedAt) / 1000)) : 0,
  };
}
