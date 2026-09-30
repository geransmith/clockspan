import { describe, expect, it } from 'vitest';
import { BREAK_SECONDS } from '../../../shared/timer.js';
import type { Break, Session } from '../types';
import { breakSeconds, endBreaksAt, MAX_BREAK_MINUTES, MIN_FOCUS_SECONDS, runningBreak, SET_GAP_MINUTES, SET_SIZE, suggestBreak } from './breaks';

const MIN = 60_000;
const T0 = new Date(2026, 8, 28, 9, 0).getTime();

const session = (id: number, startedAt: number, minutes: number, extra: Partial<Session> = {}): Session => ({
  id,
  date: '2026-09-28',
  label: `s${id}`,
  plannedSeconds: minutes * 60,
  startedAt,
  endedAt: startedAt + minutes * MIN,
  status: 'completed',
  pausedSeconds: 0,
  pausedAt: null,
  durationSeconds: minutes * 60,
  priorityUid: null,
  ...extra,
});

/** Sessions of these lengths one after another, each `gap` minutes after the last one ended. */
function inARow(lengths: number[], gap = 5): Session[] {
  let at = T0;
  return lengths.map((m, i) => {
    const s = session(i + 1, at, m);
    at += (m + gap) * MIN;
    return s;
  });
}

describe('suggestBreak', () => {
  it('has nothing to size before a session is completed', () => {
    expect(suggestBreak([])).toBeNull();
    expect(suggestBreak([session(1, T0, 25, { status: 'running', endedAt: null, durationSeconds: null })])).toBeNull();
    expect(suggestBreak([session(1, T0, 25, { status: 'cancelled' })])).toBeNull();
  });

  it('gives a fifth of the session, as 25 minutes earn 5', () => {
    expect(suggestBreak(inARow([25]))).toEqual({ sessionId: 1, minutes: 5, long: false, position: 1, focusSeconds: 1500 });
    expect(suggestBreak(inARow([50]))?.minutes).toBe(10);
    expect(suggestBreak(inARow([15]))?.minutes).toBe(3);
    expect(suggestBreak(inARow([27]))?.minutes).toBe(5);
    expect(suggestBreak(inARow([28]))?.minutes).toBe(6);
  });

  it('sizes on the focus logged, not the plan', () => {
    const [s] = inARow([25]);
    expect(suggestBreak([{ ...s!, durationSeconds: 40 * 60 }])?.minutes).toBe(8);
  });

  it('passes over a false start: under a minute of focus earns nothing and is not one of a set', () => {
    const [a, b, c] = inARow([25, 25, 25]);
    const blip = session(9, c!.endedAt! + 2 * MIN, 0.5);
    expect(suggestBreak([blip])).toBeNull();
    expect(suggestBreak([{ ...blip, durationSeconds: MIN_FOCUS_SECONDS }])).toMatchObject({ sessionId: 9, minutes: 1 });
    // The latest real session is still c, third of its set.
    expect(suggestBreak([a!, b!, c!, blip])).toMatchObject({ sessionId: 3, position: 3 });
  });

  it('never goes under a minute or past 30', () => {
    expect(suggestBreak(inARow([1]))?.minutes).toBe(1);
    expect(suggestBreak(inARow([200]))?.minutes).toBe(MAX_BREAK_MINUTES);
  });

  it('only suggests a length the server takes', () => {
    expect(BREAK_SECONDS.min).toBeLessThanOrEqual(60);
    expect(BREAK_SECONDS.max).toBeGreaterThanOrEqual(MAX_BREAK_MINUTES * 60);
  });

  it('gives the fourth session in a row a long break, a fifth of the four together', () => {
    const sessions = inARow([25, 25, 25, 25]);
    expect(suggestBreak(sessions.slice(0, 3))).toMatchObject({ minutes: 5, long: false, position: 3 });
    expect(suggestBreak(sessions)).toEqual({ sessionId: 4, minutes: 20, long: true, position: SET_SIZE, focusSeconds: 100 * 60 });
    expect(suggestBreak(inARow([50, 50, 50, 50]))).toMatchObject({ minutes: 30, long: true });
    expect(suggestBreak(inARow([15, 25, 15, 5]))).toMatchObject({ minutes: 12, long: true, focusSeconds: 60 * 60 });
  });

  it('keeps counting through a long break that was skipped', () => {
    const sessions = inARow([25, 25, 25, 25, 25, 25, 25, 25]);
    expect(suggestBreak(sessions.slice(0, 5))).toMatchObject({ minutes: 5, long: false, position: 1 });
    expect(suggestBreak(sessions)).toMatchObject({ minutes: 20, long: true, position: 4 });
  });

  it('starts the count over after a gap as long as a long break', () => {
    const before = inARow([25, 25, 25]);
    const after = session(4, before[2]!.endedAt! + SET_GAP_MINUTES * MIN, 25);
    expect(suggestBreak([...before, after])).toMatchObject({ minutes: 5, long: false, position: 1 });
    const justUnder = session(4, before[2]!.endedAt! + SET_GAP_MINUTES * MIN - 1, 25);
    expect(suggestBreak([...before, justUnder])).toMatchObject({ minutes: 20, long: true });
  });

  it('reads the sessions in the order they ran, and skips a cancelled one', () => {
    const [a, b, c, d] = inARow([25, 25, 25, 25]);
    expect(suggestBreak([d!, b!, a!, c!])).toMatchObject({ long: true, position: 4 });
    // The latest completed one is b: a cancelled session earns nothing.
    expect(suggestBreak([a!, b!, { ...c!, status: 'cancelled' }])).toMatchObject({ long: false, position: 2 });
  });
});

describe('logged breaks', () => {
  const rest = (id: number, at: number, minutes: number, endedAt = T0 + (at + minutes) * MIN): Break => ({
    id,
    date: '2026-09-28',
    plannedSeconds: minutes * 60,
    startedAt: T0 + at * MIN,
    endedAt,
  });

  it('counts the rest so far while a break runs, and its whole length once over', () => {
    const b = rest(1, 0, 5);
    expect(breakSeconds(b, T0 - MIN)).toBe(0);
    expect(breakSeconds(b, T0 + 2 * MIN)).toBe(120);
    expect(breakSeconds(b, T0 + 60 * MIN)).toBe(300);
    expect(breakSeconds(rest(2, 0, 5, T0 + 90_000), T0 + 60 * MIN)).toBe(90);
  });

  it('ends the break running at a moment there, and drops it if it ran under a minute', () => {
    const over = rest(1, 0, 5);
    const running = rest(2, 30, 10);
    expect(endBreaksAt([over, running], T0 + 32 * MIN)).toEqual([over, { ...running, endedAt: T0 + 32 * MIN }]);
    expect(endBreaksAt([over, running], T0 + 31 * MIN)).toEqual([over, { ...running, endedAt: T0 + 31 * MIN }]);
    expect(endBreaksAt([over, running], T0 + 31 * MIN - 1)).toEqual([over]);
    // Nothing running then: nothing changes.
    expect(endBreaksAt([over, running], T0 + 50 * MIN)).toEqual([over, running]);
  });

  it('finds the break running now: the latest one, while its end is ahead', () => {
    const breaks = [rest(1, 0, 5), rest(2, 30, 10)];
    expect(runningBreak([], T0)).toBeNull();
    expect(runningBreak(breaks.slice(0, 1), T0 + 2 * MIN)).toBe(breaks[0]);
    expect(runningBreak(breaks.slice(0, 1), T0 + 5 * MIN)).toBeNull();
    expect(runningBreak(breaks, T0 + 35 * MIN)).toBe(breaks[1]);
    expect(runningBreak(breaks, T0 + 40 * MIN)).toBeNull();
  });
});
