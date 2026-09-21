import { describe, expect, it } from 'vitest';
import type { Priority, Session } from '../types';
import { reviewDay } from './retro';

const row = (position: number, text: string, extra: Partial<Priority> = {}): Priority => ({
  position,
  text,
  done: false,
  uid: `uid${position}00000000`,
  addedAt: 1000,
  ...extra,
});
const session = (id: number, startedAt: number, seconds: number, extra: Partial<Session> = {}): Session => ({
  id,
  date: '2026-09-16',
  label: `s${id}`,
  notes: '',
  plannedSeconds: seconds,
  startedAt,
  endedAt: startedAt + seconds * 1000,
  status: 'completed',
  durationSeconds: seconds,
  priorityUid: null,
  ...extra,
});

describe('reviewDay', () => {
  it('splits time into on-plan and off-plan by uid', () => {
    const priorities = [row(1, 'Ship the report', { done: true }), row(2, 'Call the bank'), row(3, '')];
    const sessions = [
      session(1, 10_000, 1500, { priorityUid: 'uid100000000' }),
      session(2, 20_000, 900, { priorityUid: 'uid100000000' }),
      session(3, 30_000, 600),
      session(4, 40_000, 300, { priorityUid: 'gone00000000' }),
    ];
    const r = reviewDay(priorities, sessions);
    expect(r.total).toBe(2);
    expect(r.done).toBe(1);
    expect(r.planned.map((p) => [p.priority.position, p.focusedSeconds, p.sessions])).toEqual([
      [1, 2400, 2],
      [2, 0, 0],
    ]);
    expect(r.unplanned.map((s) => s.id)).toEqual([3, 4]);
    expect(r.onPlanSeconds).toBe(2400);
    expect(r.offPlanSeconds).toBe(900);
  });

  it('counts a completed session with no duration as zero and skips rows that never got a uid', () => {
    // Old data: a row saved before uids existed, and a completed session whose end was never written.
    const priorities = [row(1, 'Before uids', { uid: null }), row(2, 'Planned')];
    const r = reviewDay(priorities, [session(1, 10_000, 600, { durationSeconds: null, priorityUid: 'uid200000000' })]);
    expect(r.planned.map((p) => [p.priority.position, p.focusedSeconds, p.sessions])).toEqual([
      [1, 0, 0],
      [2, 0, 1],
    ]);
    expect(r.onPlanSeconds).toBe(0);
  });

  it('ignores running and cancelled sessions', () => {
    const r = reviewDay([row(1, 'A')], [session(1, 10_000, 600, { status: 'running', endedAt: null, durationSeconds: null, priorityUid: 'uid100000000' })]);
    expect(r.onPlanSeconds).toBe(0);
    expect(r.unplanned).toHaveLength(0);
  });

  it('flags rows written after the first session started', () => {
    const priorities = [row(1, 'Planned', { addedAt: 5_000 }), row(2, 'From the manager', { addedAt: 50_000 }), row(3, 'Old data', { addedAt: null })];
    const r = reviewDay(priorities, [session(1, 10_000, 600)]);
    expect(r.planned.map((p) => p.addedMidDay)).toEqual([false, true, false]);
    // Nothing is mid-day when no work has started.
    expect(reviewDay(priorities, []).planned.every((p) => !p.addedMidDay)).toBe(true);
  });

  it('is empty for an empty day', () => {
    expect(reviewDay([], [])).toEqual({ planned: [], unplanned: [], onPlanSeconds: 0, offPlanSeconds: 0, done: 0, total: 0 });
  });
});
