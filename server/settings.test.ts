import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTING_LIMITS } from '../shared/settings.js';
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
      ['retro', true, 'right'],
    ]);
    // A row stored before the columns: every card takes its default, with no migration.
    const old = mergeSettings(DEFAULT_SETTINGS, { layout: [{ id: 'retro', visible: false }] }).layout;
    expect(old.map((l) => l.side)).toEqual(['right', 'left', 'left', 'right', 'right']);
    // A save that leaves the layout out keeps the stored columns.
    const stored = { ...DEFAULT_SETTINGS, layout: merged };
    expect(mergeSettings(stored, { sound: false }).layout).toBe(merged);
  });

  it('keeps retention within bounds, field by field', () => {
    expect(mergeSettings(DEFAULT_SETTINGS, { retention: { enabled: true, days: 90 } }).retention).toEqual({ enabled: true, days: 90 });
    expect(mergeSettings(DEFAULT_SETTINGS, { retention: { enabled: 'yes', days: 7 } }).retention).toEqual(DEFAULT_SETTINGS.retention);
    expect(mergeSettings(DEFAULT_SETTINGS, { retention: { enabled: true, days: 4000 } }).retention).toEqual({ enabled: true, days: 365 });
    expect(mergeSettings(DEFAULT_SETTINGS, { retention: 'forever' }).retention).toEqual(DEFAULT_SETTINGS.retention);
  });

  it('takes every switch only as true or false, flipped from its default', () => {
    const switches = (Object.keys(DEFAULT_SETTINGS) as (keyof typeof DEFAULT_SETTINGS)[]).filter((k) => typeof DEFAULT_SETTINGS[k] === 'boolean');
    // Every top-level boolean default is a switch, so a new one is covered here with no edit; this only proves the filter finds them.
    expect(switches).toEqual(expect.arrayContaining(['sound', 'board']));
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

  it('keeps the recurring rows per day between 1 and 10', () => {
    const stored = { ...DEFAULT_SETTINGS, recurringPerDay: 4 };
    expect(mergeSettings(stored, { recurringPerDay: 0 }).recurringPerDay).toBe(4);
    expect(mergeSettings(stored, { recurringPerDay: 11 }).recurringPerDay).toBe(4);
    expect(mergeSettings(stored, { recurringPerDay: 5 }).recurringPerDay).toBe(5);
    expect(mergeSettings(DEFAULT_SETTINGS, {}).recurringPerDay).toBe(3);
  });
});
