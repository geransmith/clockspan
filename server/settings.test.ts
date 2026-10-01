import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTING_LIMITS } from '../shared/settings.js';
import { mergeSettings } from './settings.js';

describe('mergeSettings', () => {
  it('ignores non-object patches', () => {
    expect(mergeSettings(DEFAULT_SETTINGS, null)).toBe(DEFAULT_SETTINGS);
    expect(mergeSettings(DEFAULT_SETTINGS, 'x')).toBe(DEFAULT_SETTINGS);
  });

  it('returns an untouched alarm as the frozen default and a patched one as a fresh object', () => {
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
    // Every top-level boolean default is a switch, so a new one is covered here with no edit; this only proves the filter finds them.
    expect(switches).toContain('sound');
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
