import { describe, expect, it } from 'vitest';
import { MINUTE_MS } from '../../../shared/dates.js';
import { completedSession, makeDay, makePriority, makeSession, punchesAt } from '../test/fixtures';
import type { Day } from '../types';
import { editedSession, focusOf, hasContent, loggedByUid, reviewDay, sessionCategory, sessionCategoryEdit, sessionName, sessionRow } from './retro';

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
  it("adds up each task's completed sessions and a running one's time so far, and nothing else", () => {
    const sessions = [
      completedSession(1, 0, 600, { priorityUid: 'aaaaaaaaaaaa' }),
      completedSession(2, 1, 300, { priorityUid: 'aaaaaaaaaaaa' }),
      completedSession(3, 2, 120, { priorityUid: 'bbbbbbbbbbbb' }),
      completedSession(4, 3, 900),
      completedSession(5, 4, 100, { priorityUid: 'bbbbbbbbbbbb', status: 'cancelled' }),
      // Running for 10 minutes, 2 of them paused.
      makeSession({ id: 6, startedAt: 0, plannedSeconds: 900, priorityUid: 'cccccccccccc', pausedSeconds: 120 }),
    ];
    expect(loggedByUid(sessions, 10 * MINUTE_MS)).toEqual(
      new Map([
        ['aaaaaaaaaaaa', 900],
        ['bbbbbbbbbbbb', 120],
        ['cccccccccccc', 480],
      ]),
    );
    expect(loggedByUid([], 0).size).toBe(0);
  });

  it('counts a timer that has only just started, or reads as not started on a clock behind, as a second', () => {
    const running = makeSession({ id: 1, startedAt: 5000, plannedSeconds: 900, priorityUid: 'cccccccccccc' });
    expect(loggedByUid([running], 5000).get('cccccccccccc')).toBe(1);
    expect(loggedByUid([running], 4000).get('cccccccccccc')).toBe(1);
  });
});

describe('sessionName and sessionRow', () => {
  const fix = makePriority(1, '  Ship the fix ');
  const rows = [fix, makePriority(2, '', { uid: 'blank0000000' })];
  const on = (priorityUid: string | null, title: string | null = null, label = 'Started as this') => makeSession({ priorityUid, title, label });

  it("is its row's current text while the day's list holds its task, trimmed, whatever the server last called it", () => {
    expect(sessionRow(on(fix.uid), rows)).toBe(fix);
    expect(sessionName(on(fix.uid, 'Ship it'), rows)).toBe('Ship the fix');
    expect(sessionName(on(fix.uid, null, ''), rows)).toBe('Ship the fix');
  });

  it("is the task's name the server gave once the task left the day, or its row is blank in the draft, or the day isn't read", () => {
    expect(sessionName(on('gone00000000', 'Ship the hotfix'), rows)).toBe('Ship the hotfix');
    expect(sessionName(on('blank0000000', 'Blanked task'), rows)).toBe('Blanked task');
    expect(sessionRow(on('blank0000000'), rows)).toBeUndefined();
    expect(sessionName(on(fix.uid, 'Ship it'), [])).toBe('Ship it');
  });

  it('is the label for a session with no task', () => {
    expect(sessionRow(on(null), rows)).toBeUndefined();
    expect(sessionName(on(null), rows)).toBe('Started as this');
    expect(sessionName(on(null, null, ''), rows)).toBe('');
  });
});

describe("a session's category", () => {
  const TICKETS = 'cat000000001';
  const ADMIN = 'cat000000002';
  const report = makePriority(1, 'Report', { categoryUid: TICKETS });
  const email = makePriority(2, 'Email');
  const rows = [report, email];
  const on = (priorityUid: string | null, categoryUid: string | null = null) => completedSession(1, 0, 600, { priorityUid, categoryUid });

  describe('sessionCategory', () => {
    it("is its row's category while the day's list holds its task, none included, over what the server last said", () => {
      expect(sessionCategory(on(report.uid), rows)).toBe(TICKETS);
      expect(sessionCategory(on(report.uid, ADMIN), rows)).toBe(TICKETS);
      expect(sessionCategory(on(email.uid, ADMIN), rows)).toBeNull();
    });

    it("is the category the server gave off the list: the task's that left the day, or the session's own", () => {
      expect(sessionCategory(on('gone00000000', ADMIN), rows)).toBe(ADMIN);
      expect(sessionCategory(on(null, ADMIN), rows)).toBe(ADMIN);
      expect(sessionCategory(on(null), rows)).toBeNull();
    });
  });

  describe('sessionCategoryEdit', () => {
    it("sets a category as a session's own, and takes a session whose task left the day off the task", () => {
      expect(sessionCategoryEdit(on(null, ADMIN), TICKETS)).toEqual({ categoryUid: TICKETS });
      expect(sessionCategoryEdit(on(null, ADMIN), null)).toEqual({ categoryUid: null });
      expect(sessionCategoryEdit(on('gone00000000', ADMIN), TICKETS)).toEqual({ categoryUid: TICKETS, priorityUid: null });
      expect(sessionCategoryEdit(on('gone00000000', ADMIN), null)).toEqual({ categoryUid: null, priorityUid: null });
    });

    it('makes a session off the plan count under what was picked, none included', () => {
      for (const s of [on(null, ADMIN), on('gone00000000', TICKETS)]) {
        for (const picked of [TICKETS, ADMIN, null]) expect(sessionCategory(editedSession(s, sessionCategoryEdit(s, picked)), rows)).toBe(picked);
      }
    });
  });

  describe('editedSession', () => {
    const linked = (patch: Parameters<typeof completedSession>[3] = {}) =>
      completedSession(1, 0, 600, { priorityUid: report.uid, title: 'Report', label: 'Started', categoryUid: TICKETS, ...patch });

    it('lays an edit on as sent while the session keeps its task, or stays with none', () => {
      expect(editedSession(linked(), { priorityUid: report.uid })).toEqual(linked());
      expect(editedSession(on(null, ADMIN), { categoryUid: TICKETS })).toEqual(on(null, TICKETS));
      expect(editedSession(on(null, ADMIN), { priorityUid: null, label: 'Renamed' })).toEqual({ ...on(null, ADMIN), label: 'Renamed' });
    });

    it("links a session to another task, named and filed by that task's row from then on, its own category gone", () => {
      expect(editedSession(on(null, ADMIN), { priorityUid: email.uid })).toEqual({ ...on(email.uid), title: null });
      expect(sessionCategory(editedSession(on(null, ADMIN), { priorityUid: report.uid }), rows)).toBe(TICKETS);
      expect(sessionName(editedSession(linked(), { priorityUid: email.uid }), rows)).toBe('Email');
    });

    it("takes a session off its task under the task's name, unless a label is sent, in the category sent or none, as the server does", () => {
      expect(editedSession(linked(), { priorityUid: null })).toEqual(linked({ priorityUid: null, title: null, label: 'Report', categoryUid: null }));
      expect(editedSession(linked(), { priorityUid: null, label: 'Mine' })).toMatchObject({ label: 'Mine', categoryUid: null });
      expect(editedSession(linked(), { priorityUid: null, categoryUid: ADMIN })).toMatchObject({ label: 'Report', categoryUid: ADMIN });
      expect(editedSession(linked({ title: null }), { priorityUid: null })).toMatchObject({ label: 'Started' });
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
  it("splits time into on-plan and off-plan by the day's tasks", () => {
    const priorities = [
      makePriority(1, 'Ship the report', { done: true }),
      makePriority(2, 'Call the bank'),
      makePriority(3, '', { uid: null, addedAt: null }),
    ];
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
      makePriority(3, 'Monitor the queue', { uid: 'rcur00000001', recurring: true, done: true }),
      makePriority(4, 'Follow-ups', { uid: 'rcur00000002', recurring: true }),
      // Padding: no row of the day's, routine or not.
      makePriority(5, '', { uid: null, addedAt: null }),
    ];
    const r = reviewDay(priorities, [completedSession(1, 10_000, 600, { priorityUid: 'rcur00000001' })]);
    expect(r).toMatchObject({ done: 2, total: 4, routines: { done: 1, total: 2 }, onPlanSeconds: 600 });
    expect(reviewDay(priorities.slice(0, 2), []).routines).toEqual({ done: 0, total: 0 });
  });

  it('is empty for an empty day', () => {
    expect(reviewDay([], [])).toEqual({ planned: [], unplanned: [], onPlanSeconds: 0, offPlanSeconds: 0, done: 0, total: 0, routines: { done: 0, total: 0 } });
  });
});
