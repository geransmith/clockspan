import { activeMs, plannedEndAt, PLANNED_SECONDS, type SessionTiming } from '../../../shared/timer.js';

/**
 * A pause is a break, not a parking spot. One left this long was forgotten: the client
 * finishes the session, and the server logs the focus before the pause either way.
 */
export const PAUSE_LIMIT_SECONDS = 3600;

/**
 * How long a timer that has run out waits for an answer (add time, or finish) before the
 * client finishes it at the planned end: long enough to notice the chime mid-thought, short
 * enough that a walked-away session is logged at its planned length and the timer is free
 * for the next one.
 */
export const DUE_GRACE_SECONDS = 600;

export interface TimerView {
  /** Focus seconds so far; pauses excluded. */
  elapsedSeconds: number;
  /** What the countdown shows: the seconds left on the plan, held while paused; once due, minus the overrun. */
  countdownSeconds: number;
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
  /** + has something to add: the plan, or the time worked once the plan is used up, is under the longest plan the server takes. */
  canAdd: boolean;
  /**
   * Finish asks which length to log: the timer is due and the planned and worked lengths differ
   * in their whole minutes. Under a minute over, both are the same whole minutes: nothing to ask.
   */
  asksLength: boolean;
}

/** The running timer at `now`, as the countdown and its buttons show it; derived every tick, never counted. */
export function timerView(s: SessionTiming, now: number): TimerView {
  const endAt = plannedEndAt(s, now);
  const elapsedSeconds = Math.floor(activeMs(s, now) / 1000);
  const paused = s.pausedAt != null;
  const due = !paused && now >= endAt;
  const overrunSeconds = due ? Math.floor((now - endAt) / 1000) : 0;
  return {
    elapsedSeconds,
    // At most one side is non-zero, and subtracting never makes the -0 that negating would.
    countdownSeconds: Math.max(0, Math.ceil((endAt - now) / 1000)) - overrunSeconds,
    progress: Math.min(1, elapsedSeconds / s.plannedSeconds),
    endAt,
    paused,
    pausedForSeconds: paused ? Math.max(0, Math.floor((now - s.pausedAt!) / 1000)) : 0,
    due,
    overrunSeconds,
    canAdd: Math.max(s.plannedSeconds, elapsedSeconds) < PLANNED_SECONDS.max,
    asksLength: due && Math.floor(elapsedSeconds / 60) !== Math.floor(s.plannedSeconds / 60),
  };
}

/**
 * The plan that − or + (`deltaSeconds`) makes at `now`. 'finish' when the new plan is already
 * used up (shrinking below the time worked means "I'm done now"); null for a + with nothing
 * left to add, which must not finish either.
 */
export function adjustedPlan(s: SessionTiming, now: number, deltaSeconds: number): number | 'finish' | null {
  const { elapsedSeconds, canAdd } = timerView(s, now);
  if (deltaSeconds > 0 && !canAdd) return null;
  // Once the plan is used up, "+5" means five more minutes from now, not from the end.
  const from = Math.max(s.plannedSeconds, elapsedSeconds);
  // Whole minutes, like the start buttons' plans: the finish choice compares whole minutes, and
  // a plan of 30:37 would ask it 23 s after the end.
  const next = Math.min(PLANNED_SECONDS.max, Math.max(PLANNED_SECONDS.min, Math.ceil((from + deltaSeconds) / 60) * 60));
  return next <= elapsedSeconds ? 'finish' : next;
}

/**
 * Names one planned end of one session, so the "time's up" alert fires once for it: adding
 * time moves the end and re-arms, a reload with the same key does not chime again.
 */
export function dueKey(id: number, endAt: number): string {
  return `${id}:${endAt}`;
}
