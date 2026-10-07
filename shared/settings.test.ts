import { describe, expect, it } from 'vitest';
import { CARD_IDS, DEFAULT_SETTINGS, DEFAULT_SIDE, normalizeLayout } from './settings.js';

describe('DEFAULT_SETTINGS', () => {
  it('is frozen all the way down', () => {
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SETTINGS.alarms.lunchBy)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SETTINGS.alarms.lunchBy.leadMinutes)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SETTINGS.layout[0])).toBe(true);
    expect(() => (DEFAULT_SETTINGS.alarms.lunchBy.leadMinutes as number[]).push(1)).toThrow();
  });

  it('puts the timeclock and priorities in the left column and the other cards in the right', () => {
    expect(DEFAULT_SETTINGS.layout.map((l) => [l.id, l.side])).toEqual([
      ['timeclock', 'left'],
      ['priorities', 'left'],
      ['timer', 'right'],
      ['log', 'right'],
      ['retro', 'right'],
    ]);
  });
});

describe('normalizeLayout', () => {
  it('keeps order, drops unknown and repeated ids, and appends missing cards shown, in their default column', () => {
    const out = normalizeLayout([
      { id: 'retro', visible: false, side: 'left' },
      { id: 'nope', visible: true, side: 'left' },
      { id: 'retro', visible: true, side: 'right' },
    ]);
    expect(out[0]).toEqual({ id: 'retro', visible: false, side: 'left' });
    expect(out.map((l) => l.id)).toEqual(['retro', ...CARD_IDS.filter((id) => id !== 'retro')]);
    expect(out.find((l) => l.id === 'timeclock')).toEqual({ id: 'timeclock', visible: true, side: 'left' });
    expect(out.find((l) => l.id === 'log')).toEqual({ id: 'log', visible: true, side: 'right' });
  });

  it('shows every card in its default column when nothing usable was saved', () => {
    const defaults = CARD_IDS.map((id) => ({ id, visible: true, side: DEFAULT_SIDE[id] }));
    expect(normalizeLayout([null, 'retro', 3])).toEqual(defaults);
    expect(normalizeLayout([])).toEqual(DEFAULT_SETTINGS.layout);
  });

  it('reads a missing or non-boolean visible flag as shown', () => {
    expect(normalizeLayout([{ id: 'timer' }])[0]).toEqual({ id: 'timer', visible: true, side: 'right' });
    expect(normalizeLayout([{ id: 'log', visible: 'no' }])[0]).toEqual({ id: 'log', visible: true, side: 'right' });
  });

  it("keeps a card's column and reads a missing or unknown one as the card's default", () => {
    expect(normalizeLayout([{ id: 'timer', visible: true, side: 'left' }])[0]?.side).toBe('left');
    expect(normalizeLayout([{ id: 'timeclock', visible: true, side: 'right' }])[0]?.side).toBe('right');
    // A layout saved before the sheet had columns names none.
    expect(normalizeLayout([{ id: 'timeclock', visible: true }])[0]?.side).toBe('left');
    for (const side of ['middle', 'Left', 1, null]) expect(normalizeLayout([{ id: 'retro', visible: true, side }])[0]?.side, String(side)).toBe('right');
  });
});
