import { describe, expect, it } from 'vitest';
import { computeTimeclock, emptyPunches } from './timeclock';
import type { Punch } from '../types';

const settings = { workMinutes: 480, lunchDeadlineMinutes: 300, lunchMinutes: 30 };
const H = 3_600_000;
const M = 60_000;
const T0 = new Date(2026, 8, 16, 8, 0).getTime(); // 8:00 local

function punches(times: (number | null)[]): Punch[] {
  return times.map((at, position) => ({ position, kind: position % 2 === 0 ? 'in' : 'out', at }));
}

describe('computeTimeclock', () => {
  it('is empty before clock-in', () => {
    const r = computeTimeclock(emptyPunches(), settings, T0);
    expect(r.state).toBe('not-started');
    expect(r.lunchBy).toBeNull();
    expect(r.clockOutAt).toBeNull();
    expect(r.remainingSeconds).toBe(480 * 60);
  });

  it('projects lunch-by and clock-out from clock-in alone', () => {
    const r = computeTimeclock(punches([T0, null, null]), settings, T0 + 2 * H);
    expect(r.state).toBe('working');
    expect(r.lunchBy).toBe(T0 + 5 * H);
    expect(r.lunchStatus).toBe('upcoming');
    expect(r.workedSeconds).toBe(2 * 3600);
    expect(r.clockOutAt).toBe(T0 + 8.5 * H); // 8h work + 30m assumed lunch
    expect(r.clockOutStatus).toBe('upcoming');
  });

  it('never goes negative for a future clock-in', () => {
    const r = computeTimeclock(punches([T0 + H, null, null]), settings, T0);
    expect(r.workedSeconds).toBe(0);
    expect(r.clockOutAt).toBe(T0 + H + 8.5 * H);
  });

  it('flags lunch overdue after the deadline', () => {
    const r = computeTimeclock(punches([T0, null, null]), settings, T0 + 5 * H + 10 * M);
    expect(r.lunchStatus).toBe('overdue');
  });

  it('tracks a lunch in progress and keeps the 30m assumption until it runs long', () => {
    const p = punches([T0, T0 + 4 * H, null]);
    const early = computeTimeclock(p, settings, T0 + 4 * H + 10 * M);
    expect(early.state).toBe('at-lunch');
    expect(early.lunchStatus).toBe('taken');
    expect(early.workedSeconds).toBe(4 * 3600);
    expect(early.offClockSeconds).toBe(10 * 60);
    expect(early.clockOutAt).toBe(T0 + 8.5 * H);

    const long = computeTimeclock(p, settings, T0 + 4 * H + 45 * M);
    expect(long.clockOutAt).toBe(T0 + 8 * H + 45 * M); // lunch ran 15m long
  });

  it('accounts for the actual lunch length after returning', () => {
    const p = punches([T0, T0 + 4 * H, T0 + 4 * H + 45 * M]);
    const r = computeTimeclock(p, settings, T0 + 5 * H);
    expect(r.state).toBe('working');
    expect(r.workedSeconds).toBe(4 * 3600 + 15 * 60);
    expect(r.offClockSeconds).toBe(45 * 60);
    expect(r.clockOutAt).toBe(T0 + 8 * H + 45 * M);
  });

  it('supports an extra break before lunch (chronological, not positional)', () => {
    // 8:00 in, 9:30 out (appointment), 10:30 in, lunch not yet taken.
    const p = punches([T0, null, null, T0 + 1.5 * H, T0 + 2.5 * H]);
    const r = computeTimeclock(p, settings, T0 + 3 * H);
    expect(r.error).toBeNull();
    expect(r.state).toBe('working');
    expect(r.workedSeconds).toBe(2 * 3600);
    expect(r.offClockSeconds).toBe(3600);
    expect(r.lunchStatus).toBe('upcoming');
    expect(r.clockOutAt).toBe(T0 + 9.5 * H); // 8h + 1h break + 30m lunch
  });

  it('pushes clock-out later while on a non-lunch break', () => {
    const p = punches([T0, T0 + 4 * H, T0 + 4.5 * H, T0 + 6 * H, null]);
    const r = computeTimeclock(p, settings, T0 + 6 * H + 20 * M);
    expect(r.state).toBe('on-break');
    expect(r.workedSeconds).toBe(5.5 * 3600);
    expect(r.clockOutAt).toBe(T0 + 6 * H + 20 * M + 2.5 * H);
  });

  it('reports over time once the target is passed while clocked in', () => {
    const p = punches([T0, T0 + 4 * H, T0 + 4.5 * H]);
    const r = computeTimeclock(p, settings, T0 + 9 * H);
    expect(r.remainingSeconds).toBe(0);
    expect(r.overSeconds).toBe(30 * 60);
    expect(r.clockOutStatus).toBe('over');
    expect(r.clockOutAt).toBe(T0 + 8.5 * H); // anchored to the moment the target was hit
  });

  it('is done after a final clock-out with the target met', () => {
    const p = punches([T0, T0 + 4 * H, T0 + 4.5 * H, T0 + 8.5 * H, null]);
    const r = computeTimeclock(p, settings, T0 + 12 * H);
    expect(r.state).toBe('done');
    expect(r.clockOutStatus).toBe('done');
    expect(r.clockOutAt).toBe(T0 + 8.5 * H);
    expect(r.offClockSeconds).toBe(30 * 60); // open time after the final out is not counted
  });

  it('flags out-of-order punches instead of producing garbage', () => {
    const p = punches([T0, T0 + 2 * H, T0 + 1 * H]);
    const r = computeTimeclock(p, settings, T0 + 3 * H);
    expect(r.error).not.toBeNull();
  });
});

describe('frozen (past day)', () => {
  it('treats a final clock-out as done even when short of the target', () => {
    const p = punches([T0, T0 + 4 * H, T0 + 4.5 * H, T0 + 7 * H, null]);
    const r = computeTimeclock(p, settings, T0 + 16 * H, { frozen: true });
    expect(r.state).toBe('done');
    expect(r.clockOutAt).toBe(T0 + 7 * H);
    expect(r.workedSeconds).toBe(6.5 * 3600);
  });

  it('still counts an unclosed clock-in up to the frozen instant', () => {
    const r = computeTimeclock(punches([T0, null, null]), settings, T0 + 16 * H, { frozen: true });
    expect(r.state).toBe('working');
    expect(r.workedSeconds).toBe(16 * 3600);
  });
});
