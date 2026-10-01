import { describe, expect, it } from 'vitest';
import { MINUTE_MS } from './dates.js';
import { activeMs, pausedSecondsAfter, plannedEndAt } from './timer.js';

const T0 = 1_700_000_000_000;

describe('activeMs', () => {
  it('is the span when nothing was paused', () => {
    expect(activeMs({ startedAt: T0, pausedSeconds: 0, pausedAt: null }, T0 + 10 * MINUTE_MS)).toBe(10 * MINUTE_MS);
  });

  it('drops the pauses that have ended', () => {
    expect(activeMs({ startedAt: T0, pausedSeconds: 180, pausedAt: null }, T0 + 10 * MINUTE_MS)).toBe(7 * MINUTE_MS);
  });

  it('stops at the start of an open pause, however late `until` is', () => {
    const s = { startedAt: T0, pausedSeconds: 60, pausedAt: T0 + 5 * MINUTE_MS };
    expect(activeMs(s, T0 + 5 * MINUTE_MS)).toBe(4 * MINUTE_MS);
    expect(activeMs(s, T0 + 50 * MINUTE_MS)).toBe(4 * MINUTE_MS);
  });

  it('never goes negative', () => {
    expect(activeMs({ startedAt: T0, pausedSeconds: 0, pausedAt: null }, T0 - MINUTE_MS)).toBe(0);
    expect(activeMs({ startedAt: T0, pausedSeconds: 600, pausedAt: null }, T0 + MINUTE_MS)).toBe(0);
  });
});

describe('plannedEndAt', () => {
  it('is the start plus the plan while counting, pushed out by ended pauses', () => {
    expect(plannedEndAt({ startedAt: T0, plannedSeconds: 1500, pausedSeconds: 0, pausedAt: null }, T0 + MINUTE_MS)).toBe(T0 + 25 * MINUTE_MS);
    expect(plannedEndAt({ startedAt: T0, plannedSeconds: 1500, pausedSeconds: 120, pausedAt: null }, T0 + 20 * MINUTE_MS)).toBe(T0 + 27 * MINUTE_MS);
  });

  it('moves with now while paused, so the remaining time holds still', () => {
    const s = { startedAt: T0, plannedSeconds: 1500, pausedSeconds: 0, pausedAt: T0 + 10 * MINUTE_MS };
    expect(plannedEndAt(s, T0 + 10 * MINUTE_MS)).toBe(T0 + 25 * MINUTE_MS);
    expect(plannedEndAt(s, T0 + 40 * MINUTE_MS)).toBe(T0 + 55 * MINUTE_MS);
  });
});

describe('pausedSecondsAfter', () => {
  it('adds the open pause to the ended ones, rounded to the nearest second', () => {
    const s = { pausedSeconds: 60, pausedAt: T0 };
    expect(pausedSecondsAfter(s, T0 + 90_499)).toBe(150);
    // Half a second rounds up, on the server and on the screen alike.
    expect(pausedSecondsAfter(s, T0 + 90_500)).toBe(151);
  });

  it('leaves the ended pauses alone when nothing is paused', () => {
    expect(pausedSecondsAfter({ pausedSeconds: 60, pausedAt: null }, T0 + 90_500)).toBe(60);
  });
});
