import { describe, expect, it } from 'vitest';
import { HOUR_MS, MINUTE_MS } from '../../../shared/dates.js';
import { makeDay, makeSettings, punchesAt, T0, TODAY } from '../test/fixtures';
import type { Punch, Settings } from '../types';
import { formatTime } from './format';
import { dayTimeclock, overtimeOn } from './timeclock';
import { tabTitle } from './title';

/** 8:30 AM; T0 is 9:00 AM, so lunch is due by 1:30 PM and the day ends at 5:00 PM. */
const IN = T0 - 30 * MINUTE_MS;
const at = (hours: number, minutes = 0) => T0 + (hours - 9) * HOUR_MS + minutes * MINUTE_MS;
const LUNCH_BY = at(13, 30);
const withLunch = (...rest: number[]) => punchesAt(IN, at(12), at(12, 30), ...rest);

type Options = Partial<Settings> & { approved?: boolean; hour12?: boolean };

/** Today on these punches at `now`, as useTabTitle builds it. */
function today(punches: Punch[], now: number, { approved = false, hour12 = true, ...patch }: Options = {}) {
  const settings = makeSettings(patch);
  return {
    tc: dayTimeclock(makeDay(TODAY, { punches, overtimeApproved: approved }), settings, TODAY, now),
    options: {
      now,
      isToday: true,
      alarms: settings.alarms,
      overtimeApproval: settings.overtimeApproval,
      overtimeApproved: overtimeOn(settings, approved),
      formatTime: (ms: number) => formatTime(ms, hour12),
    },
  };
}

/** The title with no session or break running. */
const title = (punches: Punch[], now: number, options: Options = {}) => tabTitle(null, null, today(punches, now, options));

const session = { paused: false, countdownSeconds: 1200, name: 'Write the report' };

describe('tabTitle', () => {
  it('counts the running session down, paused, with no name and past its end', () => {
    expect(tabTitle(session, null, null)).toBe('20:00 · Write the report — Clockspan');
    expect(tabTitle({ ...session, paused: true }, null, null)).toBe('Paused 20:00 · Write the report — Clockspan');
    expect(tabTitle({ ...session, name: '' }, null, null)).toBe('20:00 — Clockspan');
    expect(tabTitle({ ...session, countdownSeconds: -2 }, null, null)).toBe('−0:02 · Write the report — Clockspan');
  });

  it('counts a break down, and a session wins over a break and a deadline', () => {
    expect(tabTitle(null, 192, today(punchesAt(IN), T0))).toBe('Break 3:12 — Clockspan');
    expect(tabTitle(session, 192, today(punchesAt(IN), T0))).toBe('20:00 · Write the report — Clockspan');
  });

  it('gives the lunch deadline, then how long it is overdue', () => {
    expect(title(punchesAt(IN), T0)).toBe('1:30 PM Lunch — Clockspan');
    expect(title(punchesAt(IN), LUNCH_BY)).toBe('Lunch overdue 0m — Clockspan');
    expect(title(punchesAt(IN), LUNCH_BY + 6 * MINUTE_MS)).toBe('Lunch overdue 6m — Clockspan');
    expect(title(punchesAt(IN), LUNCH_BY + 65 * MINUTE_MS)).toBe('Lunch overdue 1h 05m — Clockspan');
  });

  it('keeps the lunch line past the end of the day while no Lunch out is punched', () => {
    expect(title(punchesAt(at(8)), at(17, 10))).toBe('Lunch overdue 4h 10m — Clockspan');
  });

  it("gives Clock Out At's time once lunch is taken, then the tile's line past it", () => {
    expect(title(withLunch(), at(13))).toBe('5:00 PM Out — Clockspan');
    expect(title(withLunch(), at(17))).toBe('On target — Clockspan');
    expect(title(withLunch(), at(17, 18), { overtimeApproval: false })).toBe('18m past your day — Clockspan');
    expect(title(withLunch(), at(17, 18))).toBe('Over by 18m — Clockspan');
    expect(title(withLunch(), at(17, 18), { approved: true })).toBe('Over by 18m · OT approved — Clockspan');
  });

  it('gives a Clock out typed ahead, as Clock Out At shows it', () => {
    expect(title(withLunch(at(15)), at(13))).toBe('3:00 PM Out — Clockspan');
  });

  it('goes straight to Out with the meal periods off, or on a day too short to need a lunch', () => {
    expect(title(punchesAt(IN), T0, { mealRules: false })).toBe('4:30 PM Out — Clockspan');
    expect(title(punchesAt(IN), T0, { workMinutes: 240 })).toBe('12:30 PM Out — Clockspan');
  });

  it('writes the time on a 24-hour clock when that is the setting', () => {
    expect(title(punchesAt(IN), T0, { hour12: false })).toBe('13:30 Lunch — Clockspan');
  });

  it('is the plain title with today unknown, not working, or the punches out of order', () => {
    expect(tabTitle(null, null, null)).toBe('Clockspan');
    expect(title(punchesAt(), T0)).toBe('Clockspan');
    // At lunch, and out on an extra pair.
    expect(title(punchesAt(IN, at(12)), at(12, 10))).toBe('Clockspan');
    expect(title(punchesAt(IN, null, null, at(10), null, null), at(10, 10))).toBe('Clockspan');
    // A Lunch in with no Lunch out, while lunch is still due.
    const slipped = today(punchesAt(IN, null, IN + 15 * MINUTE_MS), T0);
    expect(slipped.tc).toMatchObject({ state: 'working', lunchStatus: 'upcoming', outOfOrder: { position: 2 } });
    expect(tabTitle(null, null, slipped)).toBe('Clockspan');
    // The day done.
    expect(title(withLunch(at(15)), at(15, 10))).toBe('Clockspan');
  });
});
