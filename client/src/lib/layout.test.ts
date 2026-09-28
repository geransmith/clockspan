import { describe, expect, it } from 'vitest';
import { CARD_IDS } from '../../../shared/settings.js';
import { CARD_TITLES, moveCard, setCardVisible } from './layout';

it('names every card, each once', () => {
  const titles = CARD_IDS.map((id) => CARD_TITLES[id]);
  expect(titles.every((t) => t.trim() !== '')).toBe(true);
  expect(new Set(titles).size).toBe(CARD_IDS.length);
});

// The sheet shows timeclock, timer, log, retro; priorities is hidden.
const LAYOUT = [
  { id: 'timeclock', visible: true },
  { id: 'priorities', visible: false },
  { id: 'timer', visible: true },
  { id: 'log', visible: true },
  { id: 'retro', visible: true },
] as const;
const ids = (layout: readonly { id: string }[] | null) => layout?.map((l) => l.id);

describe('moveCard', () => {
  it('moves a card among the visible ones and puts the hidden ones after them', () => {
    expect(ids(moveCard([...LAYOUT], 0, 1))).toEqual(['timer', 'timeclock', 'log', 'retro', 'priorities']);
    expect(ids(moveCard([...LAYOUT], 3, 0))).toEqual(['retro', 'timeclock', 'timer', 'log', 'priorities']);
  });

  it('answers null for a move that goes nowhere or off either end', () => {
    expect(moveCard([...LAYOUT], 2, 2)).toBeNull();
    expect(moveCard([...LAYOUT], 0, -1)).toBeNull();
    expect(moveCard([...LAYOUT], 3, 4)).toBeNull();
  });

  it('leaves the layout it was given alone', () => {
    const layout = [...LAYOUT];
    moveCard(layout, 0, 1);
    expect(ids(layout)).toEqual(ids(LAYOUT));
  });
});

describe('setCardVisible', () => {
  it('shows or hides one card where it stands', () => {
    expect(setCardVisible([...LAYOUT], 'priorities', true)[1]).toEqual({ id: 'priorities', visible: true });
    expect(setCardVisible([...LAYOUT], 'log', false).map((l) => l.visible)).toEqual([true, false, true, false, true]);
  });
});
