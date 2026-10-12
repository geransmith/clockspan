import { describe, expect, it } from 'vitest';
import { LIMITS } from '../shared/api.js';
import { DEFAULT_SETTINGS, SETTING_LIMITS, WEEKLY_MEETINGS_MAX } from '../shared/settings.js';
import { mergeSettings } from './settings.js';

describe('mergeSettings', () => {
  it('ignores non-object patches', () => {
    expect(mergeSettings(DEFAULT_SETTINGS, null)).toBe(DEFAULT_SETTINGS);
    expect(mergeSettings(DEFAULT_SETTINGS, 'x')).toBe(DEFAULT_SETTINGS);
  });

  it('takes the timer lengths button by button and keeps three', () => {
    expect(mergeSettings(DEFAULT_SETTINGS, { timerMinutes: [10, 20, 45] }).timerMinutes).toEqual([10, 20, 45]);
    // A bad entry keeps the length it would replace; extra entries are dropped, missing ones kept.
    expect(mergeSettings(DEFAULT_SETTINGS, { timerMinutes: [5, 0, 241, 90] }).timerMinutes).toEqual([5, 25, 50]);
    expect(mergeSettings(DEFAULT_SETTINGS, { timerMinutes: [12.5, '30'] }).timerMinutes).toEqual([15, 25, 50]);
    expect(mergeSettings(DEFAULT_SETTINGS, { timerMinutes: [240] }).timerMinutes).toEqual([240, 25, 50]);
    expect(mergeSettings(DEFAULT_SETTINGS, { timerMinutes: 25 }).timerMinutes).toEqual(DEFAULT_SETTINGS.timerMinutes);
  });

  it('takes a listed theme or time format and keeps the stored one for anything else', () => {
    for (const [key, good, bad] of [
      ['theme', 'dark', 'sepia'],
      ['timeFormat', '24h', '25h'],
    ] as const) {
      const stored = mergeSettings(DEFAULT_SETTINGS, { [key]: good });
      expect(stored[key]).toBe(good);
      for (const v of [bad, 1, null]) expect(mergeSettings(stored, { [key]: v })[key], `${key}: ${String(v)}`).toBe(good);
      expect(mergeSettings(stored, { [key]: 'auto' })[key]).toBe('auto');
    }
  });

  it("keeps each card's column and gives a layout saved without one the default columns", () => {
    const sent = [
      { id: 'timer', visible: true, side: 'left' },
      { id: 'timeclock', visible: false, side: 'right' },
      { id: 'log', visible: true, side: 'top' },
    ];
    const merged = mergeSettings(DEFAULT_SETTINGS, { layout: sent }).layout;
    expect(merged.map((l) => [l.id, l.visible, l.side])).toEqual([
      ['timer', true, 'left'],
      ['timeclock', false, 'right'],
      ['log', true, 'right'],
      ['priorities', true, 'left'],
      ['meetings', true, 'right'],
      ['retro', true, 'right'],
    ]);
    // A row stored before the columns: every card takes its default, with no migration.
    const old = mergeSettings(DEFAULT_SETTINGS, { layout: [{ id: 'retro', visible: false }] }).layout;
    expect(old.map((l) => l.side)).toEqual(['right', 'left', 'left', 'right', 'right', 'right']);
    // A save that leaves the layout out keeps the stored columns.
    const stored = { ...DEFAULT_SETTINGS, layout: merged };
    expect(mergeSettings(stored, { sound: false }).layout).toBe(merged);
  });

  it('keeps the weekly meetings whole, each part checked, its uid lowercased, its days sorted and its title cut', () => {
    const part = {
      uid: 'STAND000',
      title: ` ${'x'.repeat(LIMITS.meetingTitle + 3)} `,
      weekdays: [5, 1, 3, 3],
      start: 570,
      end: 585,
      since: '2026-10-01',
      until: null,
    };
    expect(mergeSettings(DEFAULT_SETTINGS, { meetings: [part] }).meetings).toEqual([
      { uid: 'stand000', title: 'x'.repeat(LIMITS.meetingTitle), weekdays: [1, 3, 5], start: 570, end: 585, since: '2026-10-01', until: null },
    ]);
    const stored = mergeSettings(DEFAULT_SETTINGS, { meetings: [part] });
    expect(mergeSettings(stored, { meetings: 'none' }).meetings).toBe(stored.meetings);
    expect(mergeSettings(stored, { meetings: [] }).meetings).toEqual([]);
  });

  it('drops a part that is not whole', () => {
    const good = { uid: 'stand000', title: 'Standup', weekdays: [1], start: 570, end: 585, since: '2026-10-01', until: '2026-10-09' };
    const bad = [
      null,
      { ...good, uid: 'x' },
      { ...good, title: 5 },
      { ...good, weekdays: [] },
      { ...good, weekdays: [0, 8, 1.5] },
      { ...good, weekdays: 'Mon' },
      { ...good, start: -1 },
      { ...good, end: 24 * 60 + 1 },
      { ...good, end: 570 },
      { ...good, since: 'soon' },
      { ...good, until: '2026-09-30' },
      { ...good, until: 'never' },
    ];
    expect(mergeSettings(DEFAULT_SETTINGS, { meetings: bad }).meetings).toEqual([]);
    expect(mergeSettings(DEFAULT_SETTINGS, { meetings: [{ ...good, weekdays: [8, 2] }] }).meetings[0]?.weekdays).toEqual([2]);
  });

  it("keeps a meeting's parts apart: one that starts before an earlier part of its uid ends is dropped, in order of their start", () => {
    const part = (since: string, until: string | null, uid = 'stand000') => ({ uid, title: 'Standup', weekdays: [1], start: 570, end: 585, since, until });
    const merged = mergeSettings(DEFAULT_SETTINGS, {
      meetings: [
        part('2026-10-12', null),
        part('2026-10-01', '2026-10-11'),
        part('2026-10-11', null),
        part('2026-10-20', null),
        part('2026-10-05', null, 'other000'),
      ],
    }).meetings;
    expect(merged.map((w) => [w.uid, w.since, w.until])).toEqual([
      ['stand000', '2026-10-01', '2026-10-11'],
      ['other000', '2026-10-05', null],
      ['stand000', '2026-10-12', null],
    ]);
  });

  it(`keeps at most ${WEEKLY_MEETINGS_MAX} parts, dropping those that ended longest ago first`, () => {
    const part = (i: number, until: string | null) => ({
      uid: `m${String(i).padStart(7, '0')}`,
      title: '',
      weekdays: [1],
      start: 0,
      end: 1,
      since: '2026-09-01',
      until,
    });
    const ended = Array.from({ length: WEEKLY_MEETINGS_MAX }, (_, i) => part(i, `2026-09-${String(2 + (i % 20)).padStart(2, '0')}`));
    const kept = mergeSettings(DEFAULT_SETTINGS, { meetings: [part(500, null), ...ended, part(501, null)] }).meetings;
    expect(kept).toHaveLength(WEEKLY_MEETINGS_MAX);
    expect(kept.filter((w) => w.until == null).map((w) => w.uid)).toEqual(['m0000500', 'm0000501']);
    // The two dropped ended on the earliest day of all.
    expect(kept.filter((w) => w.until === '2026-09-02')).toHaveLength(3);
    const running = Array.from({ length: WEEKLY_MEETINGS_MAX + 1 }, (_, i) => part(i, null));
    expect(mergeSettings(DEFAULT_SETTINGS, { meetings: running }).meetings).toHaveLength(WEEKLY_MEETINGS_MAX);
  });

  it('keeps retention within bounds, field by field', () => {
    expect(mergeSettings(DEFAULT_SETTINGS, { retention: { enabled: true, days: 90 } }).retention).toEqual({ enabled: true, days: 90 });
    expect(mergeSettings(DEFAULT_SETTINGS, { retention: { enabled: 'yes', days: 7 } }).retention).toEqual(DEFAULT_SETTINGS.retention);
    expect(mergeSettings(DEFAULT_SETTINGS, { retention: { enabled: true, days: 4000 } }).retention).toEqual({ enabled: true, days: 365 });
    expect(mergeSettings(DEFAULT_SETTINGS, { retention: 'forever' }).retention).toEqual(DEFAULT_SETTINGS.retention);
  });

  it('gives a row saved before the lunch end and break alarms existed those alarms on, with no warnings, at their repeats', () => {
    const old = { enabled: false, leadMinutes: [10], onDue: false, overdueEveryMinutes: 2 };
    const merged = mergeSettings(DEFAULT_SETTINGS, { alarms: { lunchBy: old, clockOut: old, secondMeal: old, retro: old } }).alarms;
    expect(merged.lunchEnd).toEqual({ enabled: true, leadMinutes: [], onDue: true, overdueEveryMinutes: 15 });
    expect(merged.noBreak).toEqual({ enabled: true, leadMinutes: [], onDue: true, overdueEveryMinutes: 60 });
  });

  it('takes every switch only as true or false, flipped from its default', () => {
    const switches = (Object.keys(DEFAULT_SETTINGS) as (keyof typeof DEFAULT_SETTINGS)[]).filter((k) => typeof DEFAULT_SETTINGS[k] === 'boolean');
    // Every top-level boolean default is a switch, so a new one is covered here with no edit; this only proves the filter finds them.
    expect(switches).toEqual(expect.arrayContaining(['sound', 'clockBar']));
    for (const key of switches) {
      const flipped = !DEFAULT_SETTINGS[key];
      const stored = { ...DEFAULT_SETTINGS, [key]: flipped };
      expect(mergeSettings(DEFAULT_SETTINGS, { [key]: flipped })[key], key).toBe(flipped);
      // A string, a number or null is never stored as the switch, whatever it would read as, and
      // a save that doesn't name it keeps the stored value rather than the default.
      for (const bad of ['false', 'true', 0, 1, null]) expect(mergeSettings(stored, { [key]: bad })[key], `${key}: ${String(bad)}`).toBe(flipped);
      expect(mergeSettings(stored, {})[key], key).toBe(flipped);
    }
  });

  it('bounds every numeric field by the limits the settings inputs clamp to', () => {
    for (const [key, { min, max }] of Object.entries(SETTING_LIMITS)) {
      expect(mergeSettings(DEFAULT_SETTINGS, { [key]: min })).toMatchObject({ [key]: min });
      expect(mergeSettings(DEFAULT_SETTINGS, { [key]: max })).toMatchObject({ [key]: max });
      // No default sits at its max, so a refused value that fell back to the default would show.
      const stored = { ...DEFAULT_SETTINGS, [key]: max };
      for (const bad of [min - 1, max + 1, min + 0.5]) expect(mergeSettings(stored, { [key]: bad })).toEqual(stored);
    }
    expect(mergeSettings(DEFAULT_SETTINGS, { alarms: { retro: { overdueEveryMinutes: 121 } } })).toEqual(DEFAULT_SETTINGS);
  });
});
