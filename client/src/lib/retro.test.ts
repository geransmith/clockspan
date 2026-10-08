import { describe, expect, it } from 'vitest';
import { completedSession, makeDay, makePriority, makeSession, punchesAt } from '../test/fixtures';
import type { Day } from '../types';
import { editedSession, focusOf, hasContent, loggedByUid, reviewDay, sessionCategory, sessionCategoryEdit } from './retro';

const FIRST_UID = makePriority(1, '').uid;

describe('focusOf', () => {
  it('counts completed sessions only', () => {
    const sessions = [
      completedSession(1, 0, 600),
      completedSession(2, 1, 300),
      makeSession({ id: 3, startedAt: 2, plannedSeconds: 900 }),
      completedSession(4, 3, 100, { status: 'cancelled' }),
    ];
    expect(focusOf(sessions)).toEqual({ seconds: 900, count: 2 });
    expect(focusOf([])).toEqual({ seconds: 0, count: 0 });
  });
});

describe('loggedByUid', () => {
  it("adds up each row's completed sessions by uid, and nothing else", () => {
    const sessions = [
      completedSession(1, 0, 600, { priorityUid: 'aaaaaaaaaaaa' }),
      completedSession(2, 1, 300, { priorityUid: 'aaaaaaaaaaaa' }),
      completedSession(3, 2, 120, { priorityUid: 'bbbbbbbbbbbb' }),
      completedSession(4, 3, 900),
      completedSession(5, 4, 100, { priorityUid: 'bbbbbbbbbbbb', status: 'cancelled' }),
      makeSession({ id: 6, startedAt: 5, plannedSeconds: 900, priorityUid: 'cccccccccccc' }),
    ];
    expect(loggedByUid(sessions)).toEqual(
      new Map([
        ['aaaaaaaaaaaa', 900],
        ['bbbbbbbbbbbb', 120],
      ]),
    );
    expect(loggedByUid([]).size).toBe(0);
  });
});

describe("a session's category", () => {
  const TICKETS = 'cat000000001';
  const ADMIN = 'cat000000002';
  const report = makePriority(1, 'Report', { categoryUid: TICKETS });
  const email = makePriority(2, 'Email');
  const emptied = makePriority(3, '', { uid: 'emptied00000', categoryUid: ADMIN });
  const rows = [report, email, emptied];
  const on = (priorityUid: string | null, categoryUid: string | null = null) => completedSession(1, 0, 600, { priorityUid, categoryUid });

  describe('sessionCategory', () => {
    it("is the written row's category while the session is on one, none included, over its own pick", () => {
      expect(sessionCategory(on(report.uid), rows)).toBe(TICKETS);
      expect(sessionCategory(on(report.uid, ADMIN), rows)).toBe(TICKETS);
      expect(sessionCategory(on(email.uid, ADMIN), rows)).toBeNull();
    });

    it("is the session's own category off a written row: unplanned, on a row since removed, or on an emptied one", () => {
      expect(sessionCategory(on(null, ADMIN), rows)).toBe(ADMIN);
      expect(sessionCategory(on('removed00000', ADMIN), rows)).toBe(ADMIN);
      expect(sessionCategory(on(emptied.uid, TICKETS), rows)).toBe(TICKETS);
    });

    it("is an emptied row's category when the session has none of its own, else none", () => {
      expect(sessionCategory(on(emptied.uid), rows)).toBe(ADMIN);
      expect(sessionCategory(on(emptied.uid), [{ ...emptied, categoryUid: null }])).toBeNull();
      expect(sessionCategory(on('removed00000'), rows)).toBeNull();
      expect(sessionCategory(on(null), rows)).toBeNull();
    });
  });

  describe('sessionCategoryEdit', () => {
    it("sets a category as the session's own, and leaves a session on an emptied row on it", () => {
      expect(sessionCategoryEdit(on(emptied.uid), rows, TICKETS)).toEqual({ categoryUid: TICKETS });
      expect(sessionCategoryEdit(on(null), rows, ADMIN)).toEqual({ categoryUid: ADMIN });
    });

    it('takes a session off an emptied row for none when the row has a category, and only then', () => {
      expect(sessionCategoryEdit(on(emptied.uid), rows, null)).toEqual({ categoryUid: null, priorityUid: null });
      expect(sessionCategoryEdit(on(emptied.uid, TICKETS), rows, null)).toEqual({ categoryUid: null, priorityUid: null });
      expect(sessionCategoryEdit(on(emptied.uid, TICKETS), [{ ...emptied, categoryUid: null }], null)).toEqual({ categoryUid: null });
      expect(sessionCategoryEdit(on('removed00000', ADMIN), rows, null)).toEqual({ categoryUid: null });
      expect(sessionCategoryEdit(on(null, ADMIN), rows, null)).toEqual({ categoryUid: null });
      // The log offers no pick on a written row; an edit there would leave the session on it.
      expect(sessionCategoryEdit(on(report.uid, ADMIN), rows, null)).toEqual({ categoryUid: null });
    });

    it('makes a session on no written row count under what was picked, none included', () => {
      for (const s of [on(null, ADMIN), on('removed00000', TICKETS), on(emptied.uid), on(emptied.uid, TICKETS)]) {
        for (const picked of [TICKETS, ADMIN, null]) expect(sessionCategory({ ...s, ...sessionCategoryEdit(s, rows, picked) }, rows)).toBe(picked);
      }
    });
  });

  describe('editedSession', () => {
    it('drops a category of its own when the edit links the session to a row, whatever it sent, as the server does', () => {
      expect(editedSession(on(null, ADMIN), { priorityUid: report.uid })).toEqual(on(report.uid));
      expect(editedSession(on(null, ADMIN), { priorityUid: report.uid, categoryUid: TICKETS })).toEqual(on(report.uid));
    });

    it('lays any other edit on as sent: an unlink, a pick, a rename', () => {
      expect(editedSession(on(report.uid), { priorityUid: null, categoryUid: ADMIN })).toEqual(on(null, ADMIN));
      expect(editedSession(on(emptied.uid, ADMIN), { categoryUid: TICKETS })).toEqual(on(emptied.uid, TICKETS));
      expect(editedSession(on(emptied.uid, ADMIN), { label: 'Renamed' })).toEqual({ ...on(emptied.uid, ADMIN), label: 'Renamed' });
    });
  });
});

describe('hasContent', () => {
  // As the store holds a day the server has no row for: padded punches, nothing else.
  const blank = (patch: Partial<Day> = {}) => makeDay('2026-09-16', patch);

  it('is false for a day with nothing on it', () => {
    expect(hasContent(blank())).toBe(false);
    expect(hasContent(blank({ priorities: [makePriority(1, '  ', { uid: null, addedAt: null })], retroNote: ' \n' }))).toBe(false);
    expect(hasContent(blank({ sessions: [makeSession({ startedAt: 0, plannedSeconds: 600 })] }))).toBe(false);
    expect(hasContent(blank({ sessions: [completedSession(1, 0, 600, { status: 'cancelled' })], workMinutes: 270, overtimeApproved: true }))).toBe(false);
  });

  it('is true for any one thing on the day', () => {
    expect(hasContent(blank({ punches: punchesAt(null, 1000) }))).toBe(true);
    expect(hasContent(blank({ priorities: [makePriority(1, 'Ship it')] }))).toBe(true);
    expect(hasContent(blank({ sessions: [completedSession(1, 0, 600)] }))).toBe(true);
    expect(hasContent(blank({ retroNote: 'Why' }))).toBe(true);
    expect(hasContent(blank({ retroAt: 1000 }))).toBe(true);
  });
});

describe('reviewDay', () => {
  it('splits time into on-plan and off-plan by uid', () => {
    const priorities = [makePriority(1, 'Ship the report', { done: true }), makePriority(2, 'Call the bank'), makePriority(3, '')];
    const sessions = [
      completedSession(1, 10_000, 1500, { priorityUid: FIRST_UID }),
      completedSession(2, 20_000, 900, { priorityUid: FIRST_UID }),
      completedSession(3, 30_000, 600),
      completedSession(4, 40_000, 300, { priorityUid: 'gone00000000' }),
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

  it('ignores running and cancelled sessions', () => {
    const r = reviewDay(
      [makePriority(1, 'A')],
      [
        makeSession({ startedAt: 10_000, plannedSeconds: 600, priorityUid: FIRST_UID }),
        completedSession(2, 20_000, 600, { status: 'cancelled', priorityUid: FIRST_UID }),
      ],
    );
    expect(r.onPlanSeconds).toBe(0);
    expect(r.unplanned).toHaveLength(0);
  });

  it('flags rows written after the first session started', () => {
    const priorities = [
      makePriority(1, 'Planned', { addedAt: 5_000 }),
      makePriority(2, 'From the manager', { addedAt: 50_000 }),
      makePriority(3, 'No addedAt', { addedAt: null }),
    ];
    const r = reviewDay(priorities, [completedSession(1, 10_000, 600)]);
    expect(r.planned.map((p) => p.addedMidDay)).toEqual([false, true, false]);
    // Nothing is mid-day when no work has started.
    expect(reviewDay(priorities, []).planned.every((p) => !p.addedMidDay)).toBe(true);
  });

  it('counts the routines among the rows, and on their own', () => {
    const priorities = [
      makePriority(1, 'Ship the report', { done: true }),
      makePriority(2, 'Call the bank'),
      makePriority(3, 'Monitor the queue', { recurringUid: 'rcur00000001', done: true }),
      makePriority(4, 'Follow-ups', { recurringUid: 'rcur00000002' }),
      // Emptied: no longer one of the day's rows, routine or not.
      makePriority(5, '', { recurringUid: 'rcur00000003' }),
    ];
    const r = reviewDay(priorities, [completedSession(1, 10_000, 600, { priorityUid: makePriority(3, '').uid })]);
    expect(r).toMatchObject({ done: 2, total: 4, routines: { done: 1, total: 2 }, onPlanSeconds: 600 });
    expect(reviewDay(priorities.slice(0, 2), []).routines).toEqual({ done: 0, total: 0 });
  });

  it('is empty for an empty day', () => {
    expect(reviewDay([], [])).toEqual({ planned: [], unplanned: [], onPlanSeconds: 0, offPlanSeconds: 0, done: 0, total: 0, routines: { done: 0, total: 0 } });
  });
});
