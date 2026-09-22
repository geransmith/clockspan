import { describe, expect, it } from 'vitest';
import { activeMs, plannedEndAt } from './timer.js';

const T0 = 1_700_000_000_000;
const MIN = 60_000;

describe('activeMs', () => {
  it('is the span when nothing was paused', () => {
    expect(activeMs({ startedAt: T0, pausedSeconds: 0, pausedAt: null }, T0 + 10 * MIN)).toBe(10 * MIN);
  });

  it('drops the pauses that have ended', () => {
    expect(activeMs({ startedAt: T0, pausedSeconds: 180, pausedAt: null }, T0 + 10 * MIN)).toBe(7 * MIN);
  });

  it('stops at the start of an open pause, however late `until` is', () => {
    const s = { startedAt: T0, pausedSeconds: 60, pausedAt: T0 + 5 * MIN };
    expect(activeMs(s, T0 + 5 * MIN)).toBe(4 * MIN);
    expect(activeMs(s, T0 + 50 * MIN)).toBe(4 * MIN);
  });

  it('never goes negative', () => {
    expect(activeMs({ startedAt: T0, pausedSeconds: 0, pausedAt: null }, T0 - MIN)).toBe(0);
    expect(activeMs({ startedAt: T0, pausedSeconds: 600, pausedAt: null }, T0 + MIN)).toBe(0);
  });
});

describe('plannedEndAt', () => {
  it('is the start plus the plan while counting, pushed out by ended pauses', () => {
    expect(plannedEndAt({ startedAt: T0, plannedSeconds: 1500, pausedSeconds: 0, pausedAt: null }, T0 + MIN)).toBe(T0 + 25 * MIN);
    expect(plannedEndAt({ startedAt: T0, plannedSeconds: 1500, pausedSeconds: 120, pausedAt: null }, T0 + 20 * MIN)).toBe(T0 + 27 * MIN);
  });

  it('moves with now while paused, so the remaining time holds still', () => {
    const s = { startedAt: T0, plannedSeconds: 1500, pausedSeconds: 0, pausedAt: T0 + 10 * MIN };
    expect(plannedEndAt(s, T0 + 10 * MIN)).toBe(T0 + 25 * MIN);
    expect(plannedEndAt(s, T0 + 40 * MIN)).toBe(T0 + 55 * MIN);
  });
});
