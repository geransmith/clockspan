import { describe, expect, it } from 'vitest';
import { emptyDay } from '../../../shared/api.js';
import type { Day, Priority, Session } from '../types';
import { focusOf, hasContent, reviewDay } from './retro';
import { emptyPunches } from './timeclock';

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
  plannedSeconds: seconds,
  startedAt,
  endedAt: startedAt + seconds * 1000,
  status: 'completed',
  pausedSeconds: 0,
  pausedAt: null,
  durationSeconds: seconds,
  priorityUid: null,
  ...extra,
});

describe('focusOf', () => {
  it('counts completed sessions only', () => {
    const sessions = [
      session(1, 0, 600),
      session(2, 1, 300),
      session(3, 2, 900, { status: 'running', endedAt: null, durationSeconds: null }),
      session(4, 3, 100, { status: 'cancelled' }),
    ];
    expect(focusOf(sessions)).toEqual({ seconds: 900, count: 2 });
    expect(focusOf([])).toEqual({ seconds: 0, count: 0 });
  });
});

describe('hasContent', () => {
  // As the store holds a day the server has no row for: padded punches, nothing else.
  const blank = (patch: Partial<Day> = {}): Day => ({ ...emptyDay('2026-09-16'), punches: emptyPunches(), ...patch });

  it('is false for a day with nothing on it', () => {
    expect(hasContent(blank())).toBe(false);
    expect(hasContent(blank({ priorities: [row(1, '  ', { uid: null, addedAt: null })], retroNote: ' \n' }))).toBe(false);
    expect(hasContent(blank({ sessions: [session(1, 0, 600, { status: 'running', endedAt: null, durationSeconds: null })] }))).toBe(false);
    expect(hasContent(blank({ sessions: [session(1, 0, 600, { status: 'cancelled' })], workMinutes: 270, overtimeApproved: true }))).toBe(false);
  });

  it('is true for any one thing on the day', () => {
    expect(hasContent(blank({ punches: emptyPunches().map((p) => (p.position === 1 ? { ...p, at: 1000 } : p)) }))).toBe(true);
    expect(hasContent(blank({ priorities: [row(1, 'Ship it')] }))).toBe(true);
    expect(hasContent(blank({ sessions: [session(1, 0, 600)] }))).toBe(true);
    expect(hasContent(blank({ retroNote: 'Why' }))).toBe(true);
    expect(hasContent(blank({ retroAt: 1000 }))).toBe(true);
  });
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

  it('counts a completed session with no duration as zero', () => {
    // `durationSeconds` is nullable: a completed session whose end was never written reads as none.
    const r = reviewDay([row(1, 'Planned')], [session(1, 10_000, 600, { durationSeconds: null, priorityUid: 'uid100000000' })]);
    expect(r.planned.map((p) => [p.priority.position, p.focusedSeconds, p.sessions])).toEqual([[1, 0, 1]]);
    expect(r.onPlanSeconds).toBe(0);
  });

  it('ignores running and cancelled sessions', () => {
    const r = reviewDay([row(1, 'A')], [session(1, 10_000, 600, { status: 'running', endedAt: null, durationSeconds: null, priorityUid: 'uid100000000' })]);
    expect(r.onPlanSeconds).toBe(0);
    expect(r.unplanned).toHaveLength(0);
  });

  it('flags rows written after the first session started', () => {
    const priorities = [row(1, 'Planned', { addedAt: 5_000 }), row(2, 'From the manager', { addedAt: 50_000 }), row(3, 'No addedAt', { addedAt: null })];
    const r = reviewDay(priorities, [session(1, 10_000, 600)]);
    expect(r.planned.map((p) => p.addedMidDay)).toEqual([false, true, false]);
    // Nothing is mid-day when no work has started.
    expect(reviewDay(priorities, []).planned.every((p) => !p.addedMidDay)).toBe(true);
  });

  it('is empty for an empty day', () => {
    expect(reviewDay([], [])).toEqual({ planned: [], unplanned: [], onPlanSeconds: 0, offPlanSeconds: 0, done: 0, total: 0 });
  });
});
