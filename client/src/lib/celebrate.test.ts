import { describe, expect, it } from 'vitest';
import { pickCelebration } from './celebrate';
import { CELEBRATION_EMOJI, CELEBRATION_PHRASES } from './copy';

describe('pickCelebration', () => {
  it('is stable for one seed and drawn from the lists', () => {
    const seed = new Date(2026, 8, 16, 17, 2).getTime();
    const a = pickCelebration(seed);
    expect(pickCelebration(seed)).toEqual(a);
    expect(CELEBRATION_EMOJI).toContain(a.emoji);
    expect(CELEBRATION_PHRASES).toContain(a.phrase);
  });

  it('varies across clock-outs on different days', () => {
    const picks = new Set<string>();
    for (let d = 0; d < 30; d++) {
      const c = pickCelebration(new Date(2026, 8, 1 + d, 17, 0).getTime());
      picks.add(`${c.emoji}${c.phrase}`);
    }
    expect(picks.size).toBeGreaterThan(15);
  });

  it('has twenty of each to choose from', () => {
    expect(CELEBRATION_EMOJI).toHaveLength(20);
    expect(CELEBRATION_PHRASES).toHaveLength(20);
  });
});
