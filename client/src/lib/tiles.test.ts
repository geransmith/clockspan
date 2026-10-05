import { describe, expect, it } from 'vitest';
import { atTime, pad2 } from '../../../shared/dates.js';
import { punchesAt, TEST_SETTINGS } from '../test/fixtures';
import type { Punch, Settings } from '../types';
import { addPunchPair, clampToDay, computeTimeclock, timeclockForDate } from './timeclock';
import { focusTile, timeclockTiles, type TileOptions } from './tiles';

const DAY = '2026-09-28';
const at = (h: number, m = 0) => atTime(DAY, h, m);
const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${d.getHours()}:${pad2(d.getMinutes())}`;
};

function tiles(rows: Punch[], now: number, patch: Partial<TileOptions> = {}, settings: Partial<Settings> = {}) {
  const s = { ...TEST_SETTINGS, ...settings };
  const tc = computeTimeclock(rows, s, now);
  return timeclockTiles(tc, {
    now,
    isToday: true,
    workMinutes: s.workMinutes,
    alarms: s.alarms,
    overtimeApproval: true,
    overtimeApproved: false,
    formatTime: hhmm,
    ...patch,
  });
}

/** A past day's tiles as the sheet builds them: frozen at the day's end, seen from the next morning. */
function pastTiles(rows: Punch[]) {
  const s = TEST_SETTINGS;
  const next = new Date(2026, 8, 29, 9).getTime();
  return timeclockTiles(timeclockForDate(rows, s, DAY, '2026-09-29', next), {
    now: clampToDay(DAY, '2026-09-29', next),
    isToday: false,
    workMinutes: s.workMinutes,
    alarms: s.alarms,
    overtimeApproval: true,
    overtimeApproved: false,
    formatTime: hhmm,
  });
}

const empty = punchesAt();
const clockedIn = punchesAt(at(8));
const afterLunch = punchesAt(at(8), at(12), at(12, 30));

describe('before clock-in', () => {
  it('shows dashes, the day length, and what clocking in will show', () => {
    expect(tiles(empty, at(7))).toEqual({
      lunch: { value: '—', sub: 'Clock in to see your deadline', tone: '' },
      worked: { value: '0m', sub: '8h 00m day', tone: '' },
      clockOut: { value: '—', sub: 'Clock in to see your end time', tone: '' },
    });
    expect(tiles(empty, at(7), { workMinutes: 240 }).worked.sub).toBe('4h 00m day');
  });
});

describe('Lunch by', () => {
  it('counts down, amber inside the first warning, red once overdue', () => {
    expect(tiles(clockedIn, at(9)).lunch).toEqual({ value: '13:00', sub: 'In 4h 00m', tone: '' });
    expect(tiles(clockedIn, at(12, 50)).lunch).toEqual({ value: '13:00', sub: 'In 10m', tone: 'tile--warn' });
    expect(tiles(clockedIn, at(13, 10)).lunch).toEqual({ value: '13:00', sub: 'Overdue by 10m', tone: 'tile--danger' });
  });

  it("warns from the alarm's largest lead, or 15 minutes when the alarm is off or has no warnings", () => {
    const lunchBy = (enabled: boolean, leadMinutes: number[]) => ({ ...TEST_SETTINGS.alarms.lunchBy, enabled, leadMinutes });
    const twentyLeft = (alarm: ReturnType<typeof lunchBy>) => tiles(clockedIn, at(12, 40), { alarms: { ...TEST_SETTINGS.alarms, lunchBy: alarm } }).lunch.tone;
    expect(twentyLeft(lunchBy(true, [30, 5]))).toBe('tile--warn');
    expect(twentyLeft(lunchBy(false, [30, 5]))).toBe('');
    expect(twentyLeft(lunchBy(true, []))).toBe('');
  });

  it('says when it was taken, when none is needed, and when a finished day went without', () => {
    expect(tiles(punchesAt(at(8), at(12)), at(12, 10)).lunch).toEqual({ value: '13:00', sub: 'Taken at 12:00', tone: 'tile--ok' });
    expect(tiles(clockedIn, at(9), {}, { workMinutes: 240 }).lunch.sub).toBe('Not needed today');
    expect(tiles(punchesAt(at(8), null, null, at(14)), at(14)).lunch).toEqual({ value: '13:00', sub: 'Not taken', tone: '' });
  });
});

describe('Worked', () => {
  it('is live while working, and says what is left, over or under', () => {
    expect(tiles(clockedIn, at(9)).worked).toEqual({ value: '1h 00m', sub: '7h 00m to go', tone: 'tile--live' });
    expect(tiles(afterLunch, at(17)).worked).toEqual({ value: '8h 30m', sub: '30m over target', tone: 'tile--live' });
    expect(tiles(punchesAt(at(8), null, null, at(14)), at(14)).worked).toEqual({ value: '6h 00m', sub: '2h 00m under target', tone: '' });
  });

  it('says On target at the target and for the first minute past it', () => {
    expect(tiles(punchesAt(at(8), at(12), at(12, 30), at(16, 30)), at(17)).worked).toEqual({ value: '8h 00m', sub: 'On target', tone: '' });
    expect(tiles(afterLunch, at(16, 30) + 30_000).worked).toEqual({ value: '8h 00m', sub: 'On target', tone: 'tile--live' });
    expect(tiles(afterLunch, at(16, 31)).worked.sub).toBe('1m over target');
  });
});

describe('Clock out at', () => {
  it('counts down while working, amber inside the first warning unless overtime is approved', () => {
    expect(tiles(clockedIn, at(9)).clockOut).toEqual({ value: '16:30', sub: 'In 7h 30m', tone: '' });
    expect(tiles(afterLunch, at(16, 20)).clockOut).toEqual({ value: '16:30', sub: 'In 10m', tone: 'tile--warn' });
    expect(tiles(afterLunch, at(16, 20), { overtimeApproved: true }).clockOut.tone).toBe('');
  });

  it('shows where the day would end on a break', () => {
    expect(tiles(punchesAt(at(8), at(12)), at(12, 10)).clockOut.sub).toBe('If you return now');
  });

  it('reads time past the day as overtime, approved or not, or as later when overtime is off', () => {
    expect(tiles(afterLunch, at(17)).clockOut).toEqual({ value: '16:30', sub: 'Over by 30m', tone: 'tile--danger' });
    expect(tiles(afterLunch, at(17), { overtimeApproved: true }).clockOut).toEqual({ value: '16:30', sub: 'Over by 30m · OT approved', tone: 'tile--accent' });
    expect(tiles(afterLunch, at(17), { overtimeApproval: false }).clockOut).toEqual({ value: '16:30', sub: '30m past your day', tone: 'tile--accent' });
  });

  it('says On target, not over by 0m, on a break taken at the target and for the first minute past it', () => {
    const onTarget = { value: '16:30', sub: 'On target', tone: 'tile--accent' };
    expect(tiles(addPunchPair(punchesAt(at(8), at(12), at(12, 30), at(16, 30))), at(16, 40)).clockOut).toEqual(onTarget);
    expect(tiles(afterLunch, at(16, 30) + 30_000).clockOut).toEqual(onTarget);
    expect(tiles(afterLunch, at(16, 30) + 30_000, { overtimeApproval: false }).clockOut).toEqual(onTarget);
    // A half day's Lunch out at its 4 h: at lunch, with nothing left to work.
    expect(tiles(punchesAt(at(8), at(12)), at(12, 10), {}, { workMinutes: 240 }).clockOut).toEqual({
      value: '12:00',
      sub: 'On target',
      tone: 'tile--accent',
    });
  });

  it('holds the time the target was reached on a break past it', () => {
    const out = addPunchPair(punchesAt(at(8), at(12), at(12, 30), at(17)));
    expect(tiles(out, at(17, 10)).clockOut).toEqual({ value: '16:30', sub: 'Over by 30m', tone: 'tile--danger' });
    expect(tiles(out, at(17, 40)).clockOut).toEqual({ value: '16:30', sub: 'Over by 30m', tone: 'tile--danger' });
  });

  it('marks the day complete once clocked out', () => {
    const extra = punchesAt(at(8), at(12), at(12, 30), at(14), at(14, 15), at(16, 45));
    expect(tiles(extra, at(17)).clockOut).toEqual({ value: '16:45', sub: 'Day complete', tone: 'tile--accent' });
  });
});

describe('a past day', () => {
  it('left clocked in shows no clock-out, a lunch not taken and nothing live', () => {
    expect(pastTiles(clockedIn)).toEqual({
      lunch: { value: '13:00', sub: 'Not taken', tone: '' },
      worked: { value: '15h 59m', sub: '7h 59m over target', tone: '' },
      clockOut: { value: '—', sub: 'No clock-out recorded', tone: 'tile--warn' },
    });
    // Clocked in late enough to stay short of the target by midnight.
    const late = pastTiles(punchesAt(at(20)));
    expect(late.clockOut).toEqual({ value: '—', sub: 'No clock-out recorded', tone: 'tile--warn' });
    expect(late.lunch.sub).toBe('Not taken');
  });

  it('keeps a lunch it took', () => {
    const lunchTaken = pastTiles(afterLunch);
    expect(lunchTaken.lunch).toEqual({ value: '13:00', sub: 'Taken at 12:00', tone: 'tile--ok' });
    expect(lunchTaken.clockOut.sub).toBe('No clock-out recorded');
  });
});

describe('the Focused tile', () => {
  it("shows the day's focus time and its session count", () => {
    expect(focusTile({ seconds: 25 * 60, count: 1 }, true)).toEqual({ value: '25m', sub: '1 session', tone: '' });
    expect(focusTile({ seconds: 90 * 60, count: 3 }, false)).toEqual({ value: '1h 30m', sub: '3 sessions', tone: '' });
  });

  it('says no sessions yet only while the day is still going', () => {
    expect(focusTile({ seconds: 0, count: 0 }, true).sub).toBe('No sessions yet');
    expect(focusTile({ seconds: 0, count: 0 }, false).sub).toBe('No sessions');
  });
});
