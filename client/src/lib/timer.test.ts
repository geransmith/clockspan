import { describe, expect, it } from 'vitest';
import { timerView } from './timer';

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const session = (extra: { pausedSeconds?: number; pausedAt?: number | null } = {}) => ({
  startedAt: T0,
  plannedSeconds: 1500,
  pausedSeconds: 0,
  pausedAt: null,
  ...extra,
});

describe('timerView', () => {
  it('counts down from the start while running', () => {
    const v = timerView(session(), T0 + 10 * MIN + 500);
    expect(v).toMatchObject({ elapsedSeconds: 600, remainingSeconds: 900, endAt: T0 + 25 * MIN, paused: false, pausedForSeconds: 0 });
    expect(v.progress).toBeCloseTo(0.4);
  });

  it('pushes the end out by the pauses that have ended', () => {
    const v = timerView(session({ pausedSeconds: 120 }), T0 + 12 * MIN);
    expect(v).toMatchObject({ elapsedSeconds: 600, remainingSeconds: 900, endAt: T0 + 27 * MIN });
  });

  it('holds still while paused, however long the pause lasts', () => {
    const s = session({ pausedAt: T0 + 10 * MIN });
    const early = timerView(s, T0 + 10 * MIN + 5_000);
    const late = timerView(s, T0 + 70 * MIN);
    expect(early).toMatchObject({ elapsedSeconds: 600, remainingSeconds: 900, paused: true, pausedForSeconds: 5 });
    expect(late).toMatchObject({ elapsedSeconds: 600, remainingSeconds: 900, paused: true, pausedForSeconds: 3600 });
    expect(late.endAt).toBe(T0 + 85 * MIN);
  });

  it('clamps at zero remaining and full progress once the plan is used up', () => {
    const v = timerView(session(), T0 + 30 * MIN);
    expect(v.remainingSeconds).toBe(0);
    expect(v.progress).toBe(1);
    expect(v.elapsedSeconds).toBe(1800);
  });

  it('never reports a pause of negative length', () => {
    expect(timerView(session({ pausedAt: T0 + 10 * MIN }), T0 + 10 * MIN - 1).pausedForSeconds).toBe(0);
  });
});
