import { describe, expect, it } from 'vitest';
import { CARD_DEFAULT_VISIBLE, CARD_IDS } from '../../../shared/settings.js';
import { CARDS, CARD_TITLES, cardTitle, normalizeLayout } from './layout';

describe('normalizeLayout', () => {
  it('keeps order, drops unknown and repeated ids, and appends missing cards with their default', () => {
    const out = normalizeLayout([
      { id: 'retro', visible: false },
      { id: 'nope' as never, visible: true },
      { id: 'retro', visible: true },
    ]);
    expect(out[0]).toEqual({ id: 'retro', visible: false });
    expect(out.map((l) => l.id)).toEqual(['retro', ...CARD_IDS.filter((id) => id !== 'retro')]);
    expect(out.find((l) => l.id === 'timeclock')).toEqual({ id: 'timeclock', visible: true });
    expect(
      normalizeLayout([
        { id: 'log', visible: false },
        { id: 'stickers' as never, visible: true },
      ]).map((l) => l.id),
    ).not.toContain('stickers');
  });

  it('gives every card its default when nothing is saved', () => {
    expect(normalizeLayout(undefined)).toEqual(CARD_IDS.map((id) => ({ id, visible: CARD_DEFAULT_VISIBLE[id] })));
  });

  it('reads a row without a visible flag as shown', () => {
    expect(normalizeLayout([{ id: 'timer' } as never])[0]).toEqual({ id: 'timer', visible: true });
  });
});

describe('cardTitle', () => {
  it('names every card in the registry', () => {
    for (const id of CARD_IDS) expect(cardTitle(id)).toBe(CARD_TITLES[id]);
    expect(CARDS.map((c) => c.id)).toEqual([...CARD_IDS]);
  });
});
