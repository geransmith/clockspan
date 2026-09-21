import { describe, expect, it } from 'vitest';
import type { Day, DaySummary, Punch } from '../types';
import { STICKER_EMOJI } from './copy';
import { calendarMonth } from './calendar';
import { countStickers, daySummaryOf, STICKER_REASONS, stickerEmoji, stickersForDay } from './stickers';
import { emptyPunches } from './timeclock';

const settings = { workMinutes: 480, lunchDeadlineMinutes: 300, lunchMinutes: 30, secondMealAfterMinutes: 600 };
const TODAY = '2026-09-17'; // a Thursday
const NOW = new Date(2026, 8, 17, 15, 0).getTime();

function punches(date: string, times: (string | null)[]): Punch[] {
  const rows = emptyPunches();
  times.forEach((t, i) => {
    if (!t) return;
    const [h, m] = t.split(':').map(Number);
    const d = new Date(`${date}T00:00:00`);
    d.setHours(h!, m!, 0, 0);
    rows[i]!.at = d.getTime();
  });
  return rows;
}

function summary(date: string, patch: Partial<DaySummary> = {}): DaySummary {
  return { date, punches: emptyPunches(), focusSeconds: 0, prioritiesDone: 0, prioritiesTotal: 0, retroAt: null, ...patch };
}

describe('stickersForDay', () => {
  it('earns nothing for an empty day', () => {
    expect(stickersForDay(summary('2026-09-14'), settings, TODAY, NOW)).toEqual([]);
  });

  it('earns one sticker per thing the day did', () => {
    const full = summary('2026-09-14', {
      punches: punches('2026-09-14', ['08:00', '12:00', '12:30', '16:30']),
      focusSeconds: 1500,
      prioritiesDone: 3,
      prioritiesTotal: 3,
      retroAt: 1,
    });
    expect(stickersForDay(full, settings, TODAY, NOW)).toEqual(['clockedOut', 'lunch', 'priorities', 'focus', 'reviewed']);
  });

  it('judges each reason on its own', () => {
    const lunchOnly = summary('2026-09-14', { punches: punches('2026-09-14', ['08:00', '12:00', null, null]) });
    expect(stickersForDay(lunchOnly, settings, TODAY, NOW)).toEqual(['clockedOut', 'lunch']); // a past day off the clock is done
    const halfPlan = summary('2026-09-14', { prioritiesDone: 1, prioritiesTotal: 2 });
    expect(stickersForDay(halfPlan, settings, TODAY, NOW)).toEqual([]);
    const openToday = summary(TODAY, { punches: punches(TODAY, ['08:00', null, null, null]), focusSeconds: 60 });
    expect(stickersForDay(openToday, settings, TODAY, NOW)).toEqual(['focus']);
  });
});

describe('stickerEmoji', () => {
  it('is fixed per day and reason, drawn from the pool, and never repeats within a day', () => {
    const a = stickerEmoji('2026-09-14', 'lunch');
    expect(stickerEmoji('2026-09-14', 'lunch')).toBe(a);
    expect(STICKER_EMOJI).toContain(a);
    for (let d = 1; d <= 30; d++) {
      const date = `2026-09-${String(d).padStart(2, '0')}`;
      expect(new Set(STICKER_REASONS.map((r) => stickerEmoji(date, r.id))).size).toBe(STICKER_REASONS.length);
    }
    const picks = new Set(STICKER_REASONS.flatMap((r) => ['2026-09-14', '2026-09-15', '2026-09-16'].map((d) => stickerEmoji(d, r.id))));
    expect(picks.size).toBeGreaterThan(5);
  });
});

describe('daySummaryOf', () => {
  it('counts completed sessions and rows with text, like GET /days', () => {
    const day: Day = {
      date: TODAY,
      punches: emptyPunches(),
      priorities: [
        { position: 1, text: 'a', done: true, uid: 'u1', addedAt: 1 },
        { position: 2, text: '  ', done: false, uid: null, addedAt: null },
        { position: 3, text: 'b', done: false, uid: 'u3', addedAt: 1 },
      ],
      overtimeApproved: false,
      retroNote: '',
      retroAt: 5,
      sessions: [
        {
          id: 1,
          date: TODAY,
          label: '',
          notes: '',
          plannedSeconds: 1500,
          startedAt: 1,
          endedAt: 2,
          status: 'completed',
          durationSeconds: 1500,
          priorityUid: null,
        },
        {
          id: 2,
          date: TODAY,
          label: '',
          notes: '',
          plannedSeconds: 1500,
          startedAt: 3,
          endedAt: 4,
          status: 'cancelled',
          durationSeconds: 100,
          priorityUid: null,
        },
        {
          id: 3,
          date: TODAY,
          label: '',
          notes: '',
          plannedSeconds: 1500,
          startedAt: 5,
          endedAt: null,
          status: 'running',
          durationSeconds: null,
          priorityUid: null,
        },
      ],
    };
    expect(daySummaryOf(day)).toEqual({ date: TODAY, punches: day.punches, focusSeconds: 1500, prioritiesDone: 1, prioritiesTotal: 2, retroAt: 5 });
    // A completed session whose end was never written counts for nothing rather than NaN.
    const unfinished = { ...day, sessions: [{ ...day.sessions[0]!, durationSeconds: null }] };
    expect(daySummaryOf(unfinished).focusSeconds).toBe(0);
  });
});

describe('countStickers', () => {
  it('totals the month by reason and counts a day with every sticker as full', () => {
    const full = summary('2026-09-15', {
      punches: punches('2026-09-15', ['08:00', '12:00', '12:30', '16:30']),
      focusSeconds: 1,
      prioritiesDone: 1,
      prioritiesTotal: 1,
      retroAt: 1,
    });
    const days = [full, summary('2026-09-14', { retroAt: 1 }), summary('2026-09-02', { focusSeconds: 10 })];
    expect(countStickers(calendarMonth(days, settings, TODAY, NOW, '2026-09-01'))).toEqual({
      total: 7,
      full: 1,
      byReason: { clockedOut: 1, lunch: 1, priorities: 1, focus: 2, reviewed: 2 },
    });
  });
});
