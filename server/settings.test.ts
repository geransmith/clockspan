import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTING_LIMITS } from '../shared/settings.js';
import { mergeSettings } from './settings.js';

describe('mergeSettings', () => {
  it('ignores non-object patches', () => {
    expect(mergeSettings(DEFAULT_SETTINGS, null)).toBe(DEFAULT_SETTINGS);
    expect(mergeSettings(DEFAULT_SETTINGS, 'x')).toBe(DEFAULT_SETTINGS);
  });

  it('hands out defaults nobody can change in place', () => {
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SETTINGS.alarms.lunchBy)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SETTINGS.alarms.lunchBy.leadMinutes)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SETTINGS.layout[0])).toBe(true);
    expect(() => (DEFAULT_SETTINGS.alarms.lunchBy.leadMinutes as number[]).push(1)).toThrow();
    // A merge that keeps an untouched alarm returns the frozen default; a patched one is a fresh object.
    const out = mergeSettings(DEFAULT_SETTINGS, { alarms: { lunchBy: { onDue: false } } });
    expect(Object.isFrozen(out.alarms.clockOut)).toBe(true);
    expect(Object.isFrozen(out.alarms.lunchBy)).toBe(false);
  });

  it('takes the timer lengths button by button and keeps three', () => {
    expect(mergeSettings(DEFAULT_SETTINGS, { timerMinutes: [10, 20, 45] }).timerMinutes).toEqual([10, 20, 45]);
    // A bad entry keeps the length it would replace; extra entries are dropped, missing ones kept.
    expect(mergeSettings(DEFAULT_SETTINGS, { timerMinutes: [5, 0, 241, 90] }).timerMinutes).toEqual([5, 25, 50]);
    expect(mergeSettings(DEFAULT_SETTINGS, { timerMinutes: [12.5, '30'] }).timerMinutes).toEqual([15, 25, 50]);
    expect(mergeSettings(DEFAULT_SETTINGS, { timerMinutes: [240] }).timerMinutes).toEqual([240, 25, 50]);
    expect(mergeSettings(DEFAULT_SETTINGS, { timerMinutes: 25 }).timerMinutes).toEqual(DEFAULT_SETTINGS.timerMinutes);
  });

  it('keeps retention within bounds, field by field', () => {
    expect(mergeSettings(DEFAULT_SETTINGS, { retention: { enabled: true, days: 90 } }).retention).toEqual({ enabled: true, days: 90 });
    expect(mergeSettings(DEFAULT_SETTINGS, { retention: { enabled: 'yes', days: 7 } }).retention).toEqual(DEFAULT_SETTINGS.retention);
    expect(mergeSettings(DEFAULT_SETTINGS, { retention: { enabled: true, days: 4000 } }).retention).toEqual({ enabled: true, days: 365 });
    expect(mergeSettings(DEFAULT_SETTINGS, { retention: 'forever' }).retention).toEqual(DEFAULT_SETTINGS.retention);
  });

  it('takes every switch only as true or false, flipped from its default', () => {
    const switches = (Object.keys(DEFAULT_SETTINGS) as (keyof typeof DEFAULT_SETTINGS)[]).filter((k) => typeof DEFAULT_SETTINGS[k] === 'boolean');
    // A new switch lands here without a line of its own; these are the ones there are today.
    expect(switches).toEqual([
      'suggestBreaks',
      'sound',
      'notifications',
      'keepScreenAwake',
      'overtimeApproval',
      'mealRules',
      'lunchPunches',
      'trackHours',
      'celebrations',
      'stickers',
      'showWeekends',
    ]);
    for (const key of switches) {
      const flipped = !DEFAULT_SETTINGS[key];
      expect(mergeSettings(DEFAULT_SETTINGS, { [key]: flipped })[key], key).toBe(flipped);
      // A string, a number or null is never stored as the switch, whatever it would read as.
      for (const bad of ['false', 'true', 0, 1, null])
        expect(mergeSettings(DEFAULT_SETTINGS, { [key]: bad })[key], `${key}: ${String(bad)}`).toBe(DEFAULT_SETTINGS[key]);
    }
  });

  it('bounds every numeric field by the limits the settings inputs clamp to', () => {
    for (const [key, { min, max }] of Object.entries(SETTING_LIMITS)) {
      expect(mergeSettings(DEFAULT_SETTINGS, { [key]: min })).toMatchObject({ [key]: min });
      expect(mergeSettings(DEFAULT_SETTINGS, { [key]: max })).toMatchObject({ [key]: max });
      for (const bad of [min - 1, max + 1, min + 0.5]) expect(mergeSettings(DEFAULT_SETTINGS, { [key]: bad })).toEqual(DEFAULT_SETTINGS);
    }
    expect(mergeSettings(DEFAULT_SETTINGS, { alarms: { retro: { overdueEveryMinutes: 121 } } })).toEqual(DEFAULT_SETTINGS);
  });
});
