import { describe, expect, it } from 'vitest';
import { CARD_IDS } from '../../../shared/settings.js';
import { TEST_SETTINGS } from '../test/fixtures';
import type { Settings } from '../types';
import { CARD_TITLES, moveCard, setCardSide, setCardVisible, splitColumns } from './layout';

it('names every card, each once', () => {
  const titles = CARD_IDS.map((id) => CARD_TITLES[id]);
  expect(titles.every((t) => t.trim() !== '')).toBe(true);
  expect(new Set(titles).size).toBe(CARD_IDS.length);
});

// The sheet shows timeclock on the left and timer, log, retro on the right; priorities (left) is hidden.
const LAYOUT: Settings['layout'] = [
  { id: 'timeclock', visible: true, side: 'left' },
  { id: 'priorities', visible: false, side: 'left' },
  { id: 'timer', visible: true, side: 'right' },
  { id: 'log', visible: true, side: 'right' },
  { id: 'retro', visible: true, side: 'right' },
];
const ids = (layout: readonly { id: string }[] | null | undefined) => layout?.map((l) => l.id);

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

  it("moves a card within its column, counted among that column's visible cards, and leaves the other column's where they are", () => {
    // The right column is timer, log, retro: its first card goes last.
    expect(ids(moveCard([...LAYOUT], 0, 2, 'right'))).toEqual(['timeclock', 'log', 'retro', 'timer', 'priorities']);
    // A column whose cards sit between the other's in the one-column order keeps those places.
    const mixed: Settings['layout'] = [
      { id: 'timer', visible: true, side: 'right' },
      { id: 'timeclock', visible: true, side: 'left' },
      { id: 'log', visible: true, side: 'right' },
      { id: 'priorities', visible: true, side: 'left' },
      { id: 'retro', visible: false, side: 'right' },
    ];
    expect(ids(moveCard(mixed, 1, 0, 'right'))).toEqual(['log', 'timeclock', 'timer', 'priorities', 'retro']);
    expect(ids(moveCard(mixed, 0, 1, 'left'))).toEqual(['timer', 'priorities', 'log', 'timeclock', 'retro']);
  });

  it('answers null for a move off either end of its column', () => {
    expect(moveCard([...LAYOUT], 0, 1, 'left')).toBeNull();
    expect(moveCard([...LAYOUT], 0, -1, 'right')).toBeNull();
    expect(moveCard([...LAYOUT], 2, 3, 'right')).toBeNull();
  });
});

describe('setCardVisible', () => {
  it('shows or hides one card where it stands', () => {
    expect(setCardVisible([...LAYOUT], 'priorities', true)[1]).toEqual({ id: 'priorities', visible: true, side: 'left' });
    expect(setCardVisible([...LAYOUT], 'log', false).map((l) => l.visible)).toEqual([true, false, true, false, true]);
  });
});

describe('setCardSide', () => {
  it('moves one card to a column and keeps its place in the one-column order', () => {
    const next = setCardSide([...LAYOUT], 'timer', 'left');
    expect(next.map((l) => [l.id, l.side])).toEqual([
      ['timeclock', 'left'],
      ['priorities', 'left'],
      ['timer', 'left'],
      ['log', 'right'],
      ['retro', 'right'],
    ]);
    expect(LAYOUT[2]?.side).toBe('right');
  });
});

describe('splitColumns', () => {
  it("gives each column its visible cards in the layout's order", () => {
    expect(ids(splitColumns(TEST_SETTINGS.layout)?.left)).toEqual(['timeclock', 'priorities']);
    expect(ids(splitColumns(TEST_SETTINGS.layout)?.right)).toEqual(['timer', 'log', 'retro']);
    // A hidden card stays out of its column.
    expect(ids(splitColumns(LAYOUT)?.left)).toEqual(['timeclock']);
  });

  it('answers null when a column would have no visible card, so the sheet stays one list', () => {
    expect(splitColumns(setCardVisible(LAYOUT, 'timeclock', false))).toBeNull();
    expect(splitColumns(LAYOUT.map((l) => ({ ...l, side: 'left' as const })))).toBeNull();
  });
});
