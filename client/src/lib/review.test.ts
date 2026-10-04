import { describe, expect, it } from 'vitest';
import { emptyDay } from '../../../shared/api.js';
import { completedSession, TEST_SETTINGS, type EndPatch } from '../test/fixtures';
import type { Day, Priority } from '../types';
import { periodOffset, periodRange, reviewRange } from './review';

const settings = TEST_SETTINGS;
const at = (key: string, h: number, m = 0) => {
  const [y, mo, d] = key.split('-').map(Number) as [number, number, number];
  return new Date(y, mo - 1, d, h, m).getTime();
};
const row = (position: number, text: string, extra: Partial<Priority> = {}): Priority => ({
  position,
  text,
  done: false,
  uid: `uid${position}00000000`,
  addedAt: 0,
  ...extra,
});
const session = (id: number, date: string, startedAt: number, seconds: number, extra: EndPatch = {}) =>
  completedSession(id, startedAt, seconds, { date, ...extra });
const day = (date: string, extra: Partial<Day> = {}): Day => ({ ...emptyDay(date), ...extra });

describe('periodRange', () => {
  it('steps weeks, months and quarters back from today', () => {
    expect(periodRange('week', '2026-09-16', 0)).toMatchObject({ from: '2026-09-14', to: '2026-09-20' });
    expect(periodRange('week', '2026-09-16', 1)).toMatchObject({ from: '2026-09-07', to: '2026-09-13' });
    expect(periodRange('month', '2026-09-16', 0)).toMatchObject({ from: '2026-09-01', to: '2026-09-30' });
    expect(periodRange('month', '2026-03-16', 1)).toMatchObject({ from: '2026-02-01', to: '2026-02-28' });
    expect(periodRange('quarter', '2026-09-16', 0)).toMatchObject({ from: '2026-07-01', to: '2026-09-30', label: 'Q3 2026' });
    expect(periodRange('quarter', '2026-02-01', 1)).toMatchObject({ from: '2025-10-01', to: '2025-12-31', label: 'Q4 2025' });
  });
});

describe('periodOffset', () => {
  it('counts periods back from today, never forward', () => {
    expect(periodOffset('week', '2026-09-16', '2026-09-14')).toBe(0);
    expect(periodOffset('week', '2026-09-16', '2026-09-13')).toBe(1); // the Sunday before
    expect(periodOffset('week', '2026-09-16', '2026-01-02')).toBe(37); // across the year and a DST change
    // A week with a 23-hour day (spring forward) and one with a 25-hour day (fall back) are still one week.
    expect(periodOffset('week', '2026-03-09', '2026-03-02')).toBe(1);
    expect(periodOffset('week', '2026-11-02', '2026-10-26')).toBe(1);
    expect(periodOffset('month', '2026-09-16', '2026-09-01')).toBe(0);
    expect(periodOffset('month', '2026-03-16', '2025-11-30')).toBe(4);
    expect(periodOffset('quarter', '2026-09-16', '2026-07-01')).toBe(0);
    expect(periodOffset('quarter', '2026-02-01', '2025-06-30')).toBe(3);
    expect(periodOffset('week', '2026-09-16', '2026-09-21')).toBe(0);
    expect(periodOffset('month', '2026-09-16', '2026-10-01')).toBe(0);
    // Round trip: the offset always lands periodRange on the period holding the date.
    for (const kind of ['week', 'month', 'quarter'] as const) {
      for (const date of ['2025-12-30', '2026-01-01', '2026-09-15']) {
        const range = periodRange(kind, '2026-09-16', periodOffset(kind, '2026-09-16', date));
        expect(range.from <= date && date <= range.to, `${kind} ${date}`).toBe(true);
      }
    }
  });
});

describe('reviewRange', () => {
  const now = at('2026-09-16', 17);
  const d1 = day('2026-09-14', {
    punches: [
      { position: 0, kind: 'in', at: at('2026-09-14', 8) },
      { position: 1, kind: 'out', at: at('2026-09-14', 12) },
      { position: 2, kind: 'in', at: at('2026-09-14', 12, 30) },
      { position: 3, kind: 'out', at: at('2026-09-14', 16, 30) },
    ],
    priorities: [row(1, 'Ship it', { done: true }), row(2, 'Write the proposal')],
    sessions: [
      session(1, '2026-09-14', at('2026-09-14', 9), 3000, { priorityUid: 'uid100000000' }),
      session(2, '2026-09-14', at('2026-09-14', 14), 1200, { label: 'Fire drill' }),
    ],
    retroNote: '\nSlack ate the afternoon.\n\n',
    retroAt: at('2026-09-14', 16),
  });
  const d2 = day('2026-09-15', {
    priorities: [row(1, 'Call the bank', { done: true })],
    sessions: [
      session(3, '2026-09-15', at('2026-09-15', 9), 600, { priorityUid: 'uid100000000' }),
      session(4, '2026-09-15', at('2026-09-15', 10), 2400, { label: 'Help Sam' }),
    ],
  });
  const empty = day('2026-09-16');

  it('rolls days up and lists where the time went instead', () => {
    const r = reviewRange([d2, empty, d1], settings, '2026-09-16', now);
    expect(r.days).toBe(2);
    expect(r.workedSeconds).toBe(8 * 3600);
    expect(r.focusedSeconds).toBe(7200);
    expect(r.onPlanSeconds).toBe(3600);
    expect(r.offPlanSeconds).toBe(3600);
    expect(r.onPlanPercent).toBe(50);
    expect(r.prioritiesDone).toBe(2);
    expect(r.prioritiesTotal).toBe(3);
    expect(r.retrosDone).toBe(1);
    expect(r.unplanned.map((u) => [u.label, u.dates])).toEqual([
      ['Help Sam', ['2026-09-15']],
      ['Fire drill', ['2026-09-14']],
    ]);
    expect(r.notDone).toEqual([{ key: 'write the proposal', text: 'Write the proposal', dates: ['2026-09-14'], focusedSeconds: 0, addedMidDay: false }]);
    // The note as typed, without the blank lines around it.
    expect(r.notes).toEqual([{ date: '2026-09-14', note: 'Slack ate the afternoon.', reviewedAt: d1.retroAt }]);
  });

  it('leaves out a day after today, such as the next day planned tonight', () => {
    const tomorrow = day('2026-09-17', {
      priorities: [row(1, 'Write the proposal'), row(2, 'Plan ahead')],
      sessions: [session(9, '2026-09-17', at('2026-09-17', 9), 600, { label: 'Early' })],
      retroNote: 'x',
    });
    expect(reviewRange([tomorrow], settings, '2026-09-16', now).days).toBe(0);
    expect(reviewRange([d2, empty, d1, tomorrow], settings, '2026-09-16', now)).toEqual(reviewRange([d2, empty, d1], settings, '2026-09-16', now));
  });

  it('counts a day that was only marked reviewed', () => {
    const reviewed = day('2026-09-16', { retroAt: at('2026-09-16', 16) });
    expect(reviewRange([reviewed], settings, '2026-09-16', now)).toMatchObject({ days: 1, retrosDone: 1, workedSeconds: 0, notes: [] });
  });

  it('settles a priority ticked on a later day', () => {
    const mon = day('2026-09-14', {
      priorities: [row(1, 'Write the proposal')],
      sessions: [session(1, '2026-09-14', at('2026-09-14', 9), 600, { priorityUid: 'uid100000000' })],
    });
    const tue = day('2026-09-15', { priorities: [row(1, 'write the proposal ', { done: true })] });
    const r = reviewRange([tue, mon], settings, '2026-09-16', now);
    // The tile still counts each day's rows; the list is what the range never finished.
    expect(r).toMatchObject({ prioritiesDone: 1, prioritiesTotal: 2, notDone: [] });
    // Left open again after the tick: only the days since, and only their time.
    const wed = day('2026-09-16', { priorities: [row(1, 'Write the proposal')] });
    expect(reviewRange([mon, tue, wed], settings, '2026-09-16', now).notDone).toEqual([
      { key: 'write the proposal', text: 'Write the proposal', dates: ['2026-09-16'], focusedSeconds: 0, addedMidDay: false },
    ]);
    // Ticked and left open on one day, in either order: the tick wins.
    for (const priorities of [
      [row(1, 'Email', { done: true }), row(2, 'email ')],
      [row(1, 'email '), row(2, 'Email', { done: true })],
    ]) {
      expect(reviewRange([day('2026-09-14', { priorities })], settings, '2026-09-16', now).notDone).toEqual([]);
    }
  });

  it('is all zeros for no days', () => {
    expect(reviewRange([], settings, '2026-09-16', now)).toEqual({
      days: 0,
      workedSeconds: 0,
      focusedSeconds: 0,
      onPlanSeconds: 0,
      offPlanSeconds: 0,
      onPlanPercent: null,
      prioritiesDone: 0,
      prioritiesTotal: 0,
      retrosDone: 0,
      unplanned: [],
      notDone: [],
      notes: [],
    });
  });

  it('rounds the on-plan share to a whole percent, and has none without focus logged', () => {
    const third = day('2026-09-14', {
      priorities: [row(1, 'Ship it')],
      sessions: [session(1, '2026-09-14', at('2026-09-14', 9), 600, { priorityUid: 'uid100000000' }), session(2, '2026-09-14', at('2026-09-14', 10), 1200)],
    });
    expect(reviewRange([third], settings, '2026-09-16', now).onPlanPercent).toBe(33);
    const twoThirds = { ...third, sessions: third.sessions.map((s) => ({ ...s, priorityUid: s.priorityUid ? null : 'uid100000000' })) };
    expect(reviewRange([twoThirds], settings, '2026-09-16', now).onPlanPercent).toBe(67);
    // All of it off the plan is none on it, which is not the same as nothing logged.
    const offPlan = { ...third, sessions: third.sessions.map((s) => ({ ...s, priorityUid: null })) };
    expect(reviewRange([offPlan], settings, '2026-09-16', now).onPlanPercent).toBe(0);
    // A day with a plan and no sessions still counts as a day, with its rows open.
    const r = reviewRange([{ ...third, sessions: [] }], settings, '2026-09-16', now);
    expect(r).toMatchObject({ days: 1, focusedSeconds: 0, onPlanPercent: null });
    expect(r.notDone.map((g) => g.text)).toEqual(['Ship it']);
  });

  it('orders equally long unplanned work by date', () => {
    const later = day('2026-09-15', { sessions: [session(3, '2026-09-15', at('2026-09-15', 9), 600)] });
    const earlier = day('2026-09-14', { sessions: [session(1, '2026-09-14', at('2026-09-14', 9), 600)] });
    const r = reviewRange([later, earlier], settings, '2026-09-16', now);
    expect(r.unplanned.map((u) => [u.label, u.seconds])).toEqual([
      ['s1', 600],
      ['s3', 600],
    ]);
    expect(r.focusedSeconds).toBe(1200);
  });

  it('merges repeats by label or text, whatever the case and spacing', () => {
    const mon = day('2026-09-14', {
      priorities: [row(1, 'Review the PR'), row(2, 'Ship it', { done: true }), row(3, 'Plan next sprint')],
      sessions: [
        session(1, '2026-09-14', at('2026-09-14', 9), 600, { label: 'Expense receipts' }),
        session(2, '2026-09-14', at('2026-09-14', 11), 300, { label: 'expense  receipts ' }),
        session(3, '2026-09-14', at('2026-09-14', 13), 1500, { label: '' }),
        session(4, '2026-09-14', at('2026-09-14', 14), 900, { priorityUid: 'uid100000000' }),
      ],
    });
    const tue = day('2026-09-15', {
      priorities: [row(1, 'Call the bank'), row(2, 'review the PR ', { addedAt: at('2026-09-15', 12) })],
      sessions: [
        session(5, '2026-09-15', at('2026-09-15', 9), 600, { label: 'Expense Receipts' }),
        session(6, '2026-09-15', at('2026-09-15', 10), 1200, { priorityUid: 'uid200000000' }),
      ],
    });
    const r = reviewRange([tue, mon], settings, '2026-09-16', now);
    expect(r.unplanned).toEqual([
      { key: 'expense receipts', label: 'Expense Receipts', seconds: 1500, sessions: 3, dates: ['2026-09-14', '2026-09-15'] },
      { key: '', label: '', seconds: 1500, sessions: 1, dates: ['2026-09-14'] },
    ]);
    // Left open on two days comes first, then by date; the latest spelling wins; mid-day on either day counts.
    expect(r.notDone).toEqual([
      { key: 'review the pr', text: 'review the PR', dates: ['2026-09-14', '2026-09-15'], focusedSeconds: 2100, addedMidDay: true },
      { key: 'plan next sprint', text: 'Plan next sprint', dates: ['2026-09-14'], focusedSeconds: 0, addedMidDay: false },
      { key: 'call the bank', text: 'Call the bank', dates: ['2026-09-15'], focusedSeconds: 0, addedMidDay: false },
    ]);
  });
});
