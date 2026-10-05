import { describe, expect, it } from 'vitest';
import { CARD_IDS, DEFAULT_SETTINGS, normalizeLayout } from './settings.js';

describe('DEFAULT_SETTINGS', () => {
  it('is frozen all the way down', () => {
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SETTINGS.alarms.lunchBy)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SETTINGS.alarms.lunchBy.leadMinutes)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SETTINGS.layout[0])).toBe(true);
    expect(() => (DEFAULT_SETTINGS.alarms.lunchBy.leadMinutes as number[]).push(1)).toThrow();
  });
});

describe('normalizeLayout', () => {
  it('keeps order, drops unknown and repeated ids, and appends missing cards shown', () => {
    const out = normalizeLayout([
      { id: 'retro', visible: false },
      { id: 'nope', visible: true },
      { id: 'retro', visible: true },
    ]);
    expect(out[0]).toEqual({ id: 'retro', visible: false });
    expect(out.map((l) => l.id)).toEqual(['retro', ...CARD_IDS.filter((id) => id !== 'retro')]);
    expect(out.find((l) => l.id === 'timeclock')).toEqual({ id: 'timeclock', visible: true });
  });

  it('shows every card when nothing usable was saved', () => {
    const defaults = CARD_IDS.map((id) => ({ id, visible: true }));
    expect(normalizeLayout([null, 'retro', 3])).toEqual(defaults);
    expect(normalizeLayout([])).toEqual(DEFAULT_SETTINGS.layout);
  });

  it('reads a missing or non-boolean visible flag as shown', () => {
    expect(normalizeLayout([{ id: 'timer' }])[0]).toEqual({ id: 'timer', visible: true });
    expect(normalizeLayout([{ id: 'log', visible: 'no' }])[0]).toEqual({ id: 'log', visible: true });
  });
});
