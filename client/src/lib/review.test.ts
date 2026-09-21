import { describe, expect, it } from 'vitest';
import type { Day, Priority, Session } from '../types';
import { addMonths, startOfQuarter, startOfWeek } from './format';
import { periodOffset, periodRange, reviewRange } from './review';

const settings = { workMinutes: 480, lunchDeadlineMinutes: 300, lunchMinutes: 30, secondMealAfterMinutes: 600 };
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
const session = (id: number, date: string, startedAt: number, seconds: number, extra: Partial<Session> = {}): Session => ({
  id,
  date,
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
const day = (date: string, extra: Partial<Day> = {}): Day => ({
  date,
  punches: [],
  priorities: [],
  overtimeApproved: false,
  retroNote: '',
  retroAt: null,
  sessions: [],
  ...extra,
});

describe('period helpers', () => {
  it('starts weeks on Monday and quarters on the calendar quarter', () => {
    expect(startOfWeek('2026-09-16')).toBe('2026-09-14'); // Wednesday → Monday
    expect(startOfWeek('2026-09-14')).toBe('2026-09-14');
    expect(startOfWeek('2026-09-13')).toBe('2026-09-07'); // Sunday belongs to the week before
    expect(startOfQuarter('2026-09-16')).toBe('2026-07-01');
    expect(startOfQuarter('2026-12-31')).toBe('2026-10-01');
    expect(addMonths('2026-12-01', 1)).toBe('2027-01-01');
    expect(addMonths('2026-01-01', -1)).toBe('2025-12-01');
  });
});

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
    retroNote: 'Slack ate the afternoon.',
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
    expect(r.prioritiesDone).toBe(2);
    expect(r.prioritiesTotal).toBe(3);
    expect(r.retrosDone).toBe(1);
    expect(r.unplanned.map((u) => [u.date, u.session.label])).toEqual([
      ['2026-09-15', 'Help Sam'],
      ['2026-09-14', 'Fire drill'],
    ]);
    expect(r.notDone).toEqual([{ date: '2026-09-14', text: 'Write the proposal', focusedSeconds: 0, addedMidDay: false }]);
    expect(r.notes).toEqual([{ date: '2026-09-14', note: 'Slack ate the afternoon.', reviewedAt: d1.retroAt }]);
  });

  it('is all zeros for no days', () => {
    expect(reviewRange([], settings, '2026-09-16', now).days).toBe(0);
  });
});
