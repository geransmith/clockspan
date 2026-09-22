import { activeMs, plannedEndAt, type SessionTiming } from '../../../shared/timer.js';

export { activeMs };

/**
 * A pause is a break, not a parking spot. One left this long was forgotten: the client
 * finishes the session, and the server logs the focus before the pause either way.
 */
export const PAUSE_LIMIT_SECONDS = 3600;

/**
 * How long a timer that has run out waits for an answer (add time, or finish) before the
 * client finishes it at the planned end: long enough to notice the chime mid-thought, short
 * enough that a walked-away session closes and lets the screen sleep.
 */
export const DUE_GRACE_SECONDS = 600;

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
  /** The planned time is used up and the session is waiting for an answer (never while paused). */
  due: boolean;
  /** Seconds since the planned end; 0 until then. */
  overrunSeconds: number;
}

/** What the countdown shows for a running session at `now`; derived every tick, never counted. */
export function timerView(s: SessionTiming, now: number): TimerView {
  const endAt = plannedEndAt(s, now);
  const elapsedSeconds = Math.floor(activeMs(s, now) / 1000);
  const paused = s.pausedAt != null;
  return {
    elapsedSeconds,
    remainingSeconds: Math.max(0, Math.ceil((endAt - now) / 1000)),
    progress: Math.min(1, elapsedSeconds / s.plannedSeconds),
    endAt,
    paused,
    pausedForSeconds: paused ? Math.max(0, Math.floor((now - s.pausedAt!) / 1000)) : 0,
    due: !paused && now >= endAt,
    overrunSeconds: !paused && now >= endAt ? Math.floor((now - endAt) / 1000) : 0,
  };
}

/**
 * Names one planned end of one session, so the "time's up" alert fires once for it: adding
 * time moves the end and re-arms, a reload with the same key does not chime again.
 */
export function dueKey(id: number, endAt: number): string {
  return `${id}:${endAt}`;
}
