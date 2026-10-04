import { describe, expect, it } from 'vitest';
import { atTime } from '../../../shared/dates.js';
import { completedSession, makeDay, makeSession, makeSummary, punchesAt, TEST_SETTINGS } from '../test/fixtures';
import type { Punch } from '../types';
import { STICKER_EMOJI } from './copy';
import { calendarMonth } from './calendar';
import {
  countStickers,
  daySummaryOf,
  STICKER_LABELS,
  STICKER_REASONS,
  stickerEmoji,
  stickerReasons,
  stickersForDay,
  type DaySummary,
  type StickerSettings,
} from './stickers';
import { dayTimeclock } from './timeclock';

const settings = TEST_SETTINGS;
const TODAY = '2026-09-17'; // a Thursday
const NOW = new Date(2026, 8, 17, 15, 0).getTime();

function punches(date: string, times: (string | null)[]): Punch[] {
  return punchesAt(
    ...times.map((t) => {
      if (!t) return null;
      const [h, m] = t.split(':').map(Number);
      return atTime(date, h!, m!);
    }),
  );
}

/** What the calendar gives a day: its stickers, judged on its timeclock worked out once. */
const earned = (d: DaySummary, s: StickerSettings = settings) => stickersForDay(d, dayTimeclock(d, s, TODAY, NOW), stickerReasons(s));

describe('stickersForDay', () => {
  it("maps each reason's id to its label", () => {
    expect(STICKER_LABELS.lunch).toBe('Lunch taken');
  });

  it('earns nothing for an empty day', () => {
    expect(earned(makeSummary('2026-09-14'))).toEqual([]);
  });

  it('earns one sticker per thing the day did', () => {
    const full = makeSummary('2026-09-14', {
      punches: punches('2026-09-14', ['08:00', '12:00', '12:30', '16:30']),
      focusSeconds: 1500,
      prioritiesDone: 3,
      prioritiesTotal: 3,
      retroAt: 1,
    });
    expect(earned(full)).toEqual(['clockedOut', 'lunch', 'priorities', 'focus', 'reviewed']);
  });

  it('judges each reason on its own', () => {
    const lunchOnly = makeSummary('2026-09-14', { punches: punches('2026-09-14', ['08:00', '12:00', null, null]) });
    expect(earned(lunchOnly)).toEqual(['clockedOut', 'lunch']); // a past day off the clock is done
    const halfPlan = makeSummary('2026-09-14', { prioritiesDone: 1, prioritiesTotal: 2 });
    expect(earned(halfPlan)).toEqual([]);
    const openToday = makeSummary(TODAY, { punches: punches(TODAY, ['08:00', null, null, null]), focusSeconds: 60 });
    expect(earned(openToday)).toEqual(['focus']);
  });

  it('gives no Clocked out sticker with hours not tracked, and a legend and full day without it', () => {
    const noHours = { ...settings, trackHours: false };
    const lunchOnly = makeSummary('2026-09-14', { punches: punches('2026-09-14', ['08:00', '12:00', null, null]) });
    expect(earned(lunchOnly, noHours)).toEqual(['lunch']);
    expect(stickerReasons(noHours).map((r) => r.id)).toEqual(['lunch', 'priorities', 'focus', 'reviewed']);
    expect(stickerReasons(settings)).toEqual(STICKER_REASONS);
    // Everything such a day can earn makes it full.
    const all = makeSummary('2026-09-14', {
      punches: punches('2026-09-14', ['08:00', '12:00', '12:30', '16:30']),
      prioritiesDone: 1,
      prioritiesTotal: 1,
      focusSeconds: 60,
      retroAt: 1,
    });
    const weeks = calendarMonth([all], noHours, TODAY, NOW, '2026-09-01');
    expect(countStickers(weeks, stickerReasons(noHours)).full).toBe(1);
    expect(countStickers(weeks, STICKER_REASONS).full).toBe(0);
  });

  it('gives no Lunch taken sticker with the meal periods and lunch punches both off, and a legend and full day without it', () => {
    const noLunch = { ...settings, mealRules: false, lunchPunches: false };
    expect(stickerReasons(noLunch).map((r) => r.id)).toEqual(['clockedOut', 'priorities', 'focus', 'reviewed']);
    expect(stickerReasons({ ...settings, mealRules: false })).toEqual(STICKER_REASONS);
    expect(stickerReasons({ ...noLunch, trackHours: false }).map((r) => r.id)).toEqual(['priorities', 'focus', 'reviewed']);
    // A lunch punched anyway still counts on the timeclock, but earns no sticker the legend leaves out.
    const all = makeSummary('2026-09-14', {
      punches: punches('2026-09-14', ['08:00', '12:00', '12:30', '16:30']),
      prioritiesDone: 1,
      prioritiesTotal: 1,
      focusSeconds: 60,
      retroAt: 1,
    });
    expect(dayTimeclock(all, noLunch, TODAY, NOW).lunchStatus).toBe('taken');
    expect(earned(all, noLunch)).toEqual(['clockedOut', 'priorities', 'focus', 'reviewed']);
    const weeks = calendarMonth([all], noLunch, TODAY, NOW, '2026-09-01');
    expect(countStickers(weeks, stickerReasons(noLunch)).full).toBe(1);
    expect(countStickers(weeks, STICKER_REASONS).full).toBe(0);
  });

  it("earns Lunch taken, not Clocked out, for an out at a half day's end", () => {
    // Out at 12:00 is lunch on either length: only the Clock out ends today.
    const out = punches(TODAY, ['08:00', '12:00', null, null]);
    expect(earned(makeSummary(TODAY, { punches: out }))).toEqual(['lunch']);
    expect(earned(makeSummary(TODAY, { punches: out, workMinutes: 240 }))).toEqual(['lunch']);
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
  it('counts completed sessions and rows with text', () => {
    const day = makeDay(TODAY, {
      priorities: [
        { position: 1, text: 'a', done: true, uid: 'u1', addedAt: 1 },
        { position: 2, text: '  ', done: false, uid: null, addedAt: null },
        { position: 3, text: 'b', done: false, uid: 'u3', addedAt: 1 },
      ],
      retroAt: 5,
      sessions: [
        completedSession(1, 1, 1500, { label: '' }),
        completedSession(2, 3, 1500, { label: '', status: 'cancelled', durationSeconds: 100 }),
        makeSession({ id: 3, label: '', startedAt: 5 }),
      ],
    });
    expect(daySummaryOf(day)).toEqual({
      date: TODAY,
      punches: day.punches,
      focusSeconds: 1500,
      focusSessions: 1,
      prioritiesDone: 1,
      prioritiesTotal: 2,
      retroAt: 5,
      workMinutes: null,
    });
  });
});

describe('countStickers', () => {
  it('totals the month by reason and counts a day with every sticker as full', () => {
    const full = makeSummary('2026-09-15', {
      punches: punches('2026-09-15', ['08:00', '12:00', '12:30', '16:30']),
      focusSeconds: 1,
      prioritiesDone: 1,
      prioritiesTotal: 1,
      retroAt: 1,
    });
    const days = [full, makeSummary('2026-09-14', { retroAt: 1 }), makeSummary('2026-09-02', { focusSeconds: 10 })];
    expect(countStickers(calendarMonth(days, settings, TODAY, NOW, '2026-09-01'), STICKER_REASONS)).toEqual({
      total: 7,
      full: 1,
      byReason: { clockedOut: 1, lunch: 1, priorities: 1, focus: 2, reviewed: 2 },
    });
  });
});
