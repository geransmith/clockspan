import { expect, it } from 'vitest';
import { CARD_IDS } from '../../../shared/settings.js';
import { CARD_TITLES } from './layout';

it('names every card, each once', () => {
  const titles = CARD_IDS.map((id) => CARD_TITLES[id]);
  expect(titles.every((t) => t.trim() !== '')).toBe(true);
  expect(new Set(titles).size).toBe(CARD_IDS.length);
});
