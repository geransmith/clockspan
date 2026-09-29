import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../shared/settings.js';
import type { Punch, Settings } from '../types';
import { addPunchPair, computeTimeclock, emptyPunches } from './timeclock';
import { timeclockTiles, type TileOptions } from './tiles';

const at = (h: number, m = 0) => new Date(2026, 8, 28, h, m).getTime();
/** Punch rows with these times from position 0; the rest empty. */
const punches = (rows: Punch[], ...times: (number | null)[]) => rows.map((p, i) => ({ ...p, at: times[i] ?? null }));
const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function tiles(rows: Punch[], now: number, patch: Partial<TileOptions> = {}, settings: Partial<Settings> = {}) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
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

const empty = emptyPunches();
const clockedIn = punches(empty, at(8));
const afterLunch = punches(empty, at(8), at(12), at(12, 30));

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

  it("warns from the alarm's largest lead, or 15 minutes with the alarm off", () => {
    const lunchBy = (enabled: boolean, leadMinutes: number[]) => ({ ...DEFAULT_SETTINGS.alarms.lunchBy, enabled, leadMinutes });
    const twentyLeft = (alarm: ReturnType<typeof lunchBy>) =>
      tiles(clockedIn, at(12, 40), { alarms: { ...DEFAULT_SETTINGS.alarms, lunchBy: alarm } }).lunch.tone;
    expect(twentyLeft(lunchBy(true, [30, 5]))).toBe('tile--warn');
    expect(twentyLeft(lunchBy(false, [30, 5]))).toBe('');
    expect(twentyLeft(lunchBy(true, []))).toBe('');
  });

  it('says when it was taken, when none is needed, and when a finished day went without', () => {
    expect(tiles(punches(empty, at(8), at(12)), at(12, 10)).lunch).toEqual({ value: '13:00', sub: 'Taken at 12:00', tone: 'tile--ok' });
    expect(tiles(clockedIn, at(9), {}, { workMinutes: 240 }).lunch.sub).toBe('Not needed today');
    expect(tiles(punches(empty, at(8), null, null, at(14)), at(14)).lunch).toEqual({ value: '13:00', sub: 'Not taken', tone: '' });
  });
});

describe('Worked', () => {
  it('is live while working, and says what is left, over or under', () => {
    expect(tiles(clockedIn, at(9)).worked).toEqual({ value: '1h 00m', sub: '7h 00m to go', tone: 'tile--live' });
    expect(tiles(afterLunch, at(17)).worked).toEqual({ value: '8h 30m', sub: '30m over target', tone: 'tile--live' });
    expect(tiles(punches(empty, at(8), null, null, at(14)), at(14)).worked).toEqual({ value: '6h 00m', sub: '2h 00m under target', tone: '' });
  });

  it('is not live on a past day left clocked in', () => {
    expect(tiles(clockedIn, at(9), { isToday: false }).worked.tone).toBe('');
  });
});

describe('Clock out at', () => {
  it('counts down while working, amber inside the first warning unless overtime is approved', () => {
    expect(tiles(clockedIn, at(9)).clockOut).toEqual({ value: '16:30', sub: 'In 7h 30m', tone: '' });
    expect(tiles(afterLunch, at(16, 20)).clockOut).toEqual({ value: '16:30', sub: 'In 10m', tone: 'tile--warn' });
    expect(tiles(afterLunch, at(16, 20), { overtimeApproved: true }).clockOut.tone).toBe('');
  });

  it('shows where the day would end on a break, and a past day with no clock-out', () => {
    expect(tiles(punches(empty, at(8), at(12)), at(12, 10)).clockOut.sub).toBe('If you return now');
    expect(tiles(clockedIn, at(9), { isToday: false }).clockOut.sub).toBe('No clock-out recorded');
  });

  it('reads time past the day as overtime, approved or not, or as later when overtime is off', () => {
    expect(tiles(afterLunch, at(17)).clockOut).toEqual({ value: '16:30', sub: 'Over by 30m', tone: 'tile--danger' });
    expect(tiles(afterLunch, at(17), { overtimeApproved: true }).clockOut).toEqual({ value: '16:30', sub: 'Over by 30m · OT approved', tone: 'tile--accent' });
    // A day flagged while the feature was on doesn't count once it is off.
    expect(tiles(afterLunch, at(17), { overtimeApproval: false, overtimeApproved: true }).clockOut).toEqual({
      value: '16:30',
      sub: '30m past your day',
      tone: 'tile--accent',
    });
  });

  it('marks the day complete once clocked out', () => {
    const extra = punches(addPunchPair(empty), at(8), at(12), at(12, 30), at(14), at(14, 15), at(16, 45));
    expect(tiles(extra, at(17)).clockOut).toEqual({ value: '16:45', sub: 'Day complete', tone: 'tile--accent' });
  });
});
