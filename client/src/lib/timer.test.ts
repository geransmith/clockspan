import { describe, expect, it } from 'vitest';
import { HOUR_MS, MINUTE_MS } from '../../../shared/dates.js';
import { adjustedPlan, dueKey, timerView } from './timer';
import { makeSession, T0 } from '../test/fixtures';

describe('timerView', () => {
  it('counts down from the start while running', () => {
    const v = timerView(makeSession(), T0 + 10 * MINUTE_MS + 500);
    expect(v).toMatchObject({ elapsedSeconds: 600, countdownSeconds: 900, endAt: T0 + 25 * MINUTE_MS, paused: false, pausedForSeconds: 0 });
    expect(v.progress).toBeCloseTo(0.4);
  });

  it('holds still while paused, however long the pause lasts', () => {
    const s = makeSession({ pausedAt: T0 + 10 * MINUTE_MS });
    const early = timerView(s, T0 + 10 * MINUTE_MS + 5_000);
    const late = timerView(s, T0 + 70 * MINUTE_MS);
    expect(early).toMatchObject({ elapsedSeconds: 600, countdownSeconds: 900, paused: true, pausedForSeconds: 5 });
    expect(late).toMatchObject({ elapsedSeconds: 600, countdownSeconds: 900, paused: true, pausedForSeconds: 3600 });
  });

  it('caps progress at 1 and counts below zero once the plan is used up', () => {
    const v = timerView(makeSession(), T0 + 30 * MINUTE_MS);
    expect(v).toMatchObject({ elapsedSeconds: 1800, countdownSeconds: -300, progress: 1 });
  });

  it('is due from the planned end on, counting the overrun', () => {
    expect(timerView(makeSession(), T0 + 25 * MINUTE_MS - 1)).toMatchObject({ due: false, overrunSeconds: 0, countdownSeconds: 1 });
    expect(timerView(makeSession(), T0 + 25 * MINUTE_MS)).toMatchObject({ due: true, overrunSeconds: 0 });
    // A plain 0 at the end, never -0.
    expect(timerView(makeSession(), T0 + 25 * MINUTE_MS).countdownSeconds).toBe(0);
    expect(timerView(makeSession(), T0 + 28 * MINUTE_MS + 500)).toMatchObject({ due: true, overrunSeconds: 180, countdownSeconds: -180 });
  });

  it('is never due while paused, even with nothing left', () => {
    const v = timerView(makeSession({ pausedAt: T0 + 25 * MINUTE_MS }), T0 + 40 * MINUTE_MS);
    expect(v).toMatchObject({ countdownSeconds: 0, paused: true, due: false, overrunSeconds: 0 });
  });

  it('never reports a pause of negative length', () => {
    expect(timerView(makeSession({ pausedAt: T0 + 10 * MINUTE_MS }), T0 + 10 * MINUTE_MS - 1).pausedForSeconds).toBe(0);
  });

  it('can add until the plan, or the time worked past it, reaches the longest plan', () => {
    expect(timerView(makeSession(), T0 + 10 * MINUTE_MS).canAdd).toBe(true);
    expect(timerView(makeSession({ plannedSeconds: 8 * 3600 }), T0 + MINUTE_MS).canAdd).toBe(false);
    // Five minutes left to add on the plan, but the time worked is at 8 h already.
    expect(timerView(makeSession({ plannedSeconds: 8 * 3600 - 300 }), T0 + 8 * HOUR_MS).canAdd).toBe(false);
  });

  it('asks which length to log only a minute or more past the end', () => {
    expect(timerView(makeSession(), T0 + 24 * MINUTE_MS).asksLength).toBe(false);
    expect(timerView(makeSession(), T0 + 25 * MINUTE_MS + 30_000).asksLength).toBe(false);
    expect(timerView(makeSession(), T0 + 26 * MINUTE_MS).asksLength).toBe(true);
  });
});

describe('adjustedPlan', () => {
  it('moves the plan by the step mid-session', () => {
    expect(adjustedPlan(makeSession(), T0 + 10 * MINUTE_MS, 300)).toBe(1800);
    expect(adjustedPlan(makeSession(), T0 + 10 * MINUTE_MS, -300)).toBe(1200);
  });

  it('never plans under a minute', () => {
    expect(adjustedPlan(makeSession({ plannedSeconds: 120 }), T0 + 30_000, -300)).toBe(60);
  });

  it('stops at the longest plan, and + past it neither plans nor finishes', () => {
    expect(adjustedPlan(makeSession({ plannedSeconds: 8 * 3600 - 120 }), T0 + HOUR_MS, 300)).toBe(8 * 3600);
    expect(adjustedPlan(makeSession({ plannedSeconds: 8 * 3600 }), T0 + HOUR_MS, 300)).toBeNull();
    expect(adjustedPlan(makeSession({ plannedSeconds: 8 * 3600 }), T0 + 8 * HOUR_MS + 2 * MINUTE_MS, 300)).toBeNull();
  });

  it('plans whole minutes, so a minute over the new end is a whole minute', () => {
    // 25 min 37 s into a 25 min plan, after its end: five minutes from now, up to 31:00, not 30:37.
    expect(adjustedPlan(makeSession(), T0 + 1537 * 1000, 300)).toBe(31 * 60);
  });

  it('adds to the time worked once the plan is used up', () => {
    expect(adjustedPlan(makeSession(), T0 + 27 * MINUTE_MS, 300)).toBe(32 * 60);
  });

  it('finishes when the new plan is already used up', () => {
    expect(adjustedPlan(makeSession({ plannedSeconds: 120 }), T0 + 90_000, -300)).toBe('finish');
    expect(adjustedPlan(makeSession({ plannedSeconds: 120 }), T0 + MINUTE_MS, -60)).toBe('finish');
  });
});

describe('dueKey', () => {
  it('names the session and its planned end, so added time re-arms and a reload does not', () => {
    const at = timerView(makeSession(), T0 + 26 * MINUTE_MS).endAt;
    expect(dueKey(7, at)).toBe(`7:${T0 + 25 * MINUTE_MS}`);
    expect(dueKey(7, timerView(makeSession(), T0 + 27 * MINUTE_MS).endAt)).toBe(dueKey(7, at));
    expect(dueKey(7, timerView(makeSession({ plannedSeconds: 1800 }), T0 + 27 * MINUTE_MS).endAt)).not.toBe(dueKey(7, at));
    expect(dueKey(8, at)).not.toBe(dueKey(7, at));
  });
});
