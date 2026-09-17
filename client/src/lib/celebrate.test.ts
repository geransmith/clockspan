import { describe, expect, it } from 'vitest';
import { pickBurst, pickCelebration } from './celebrate';
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

describe('pickBurst', () => {
  it('gives the asked number of pieces, drawn from the list, each within its flight bounds', () => {
    const pieces = pickBurst(1234, 8);
    expect(pieces).toHaveLength(8);
    for (const p of pieces) {
      expect(CELEBRATION_EMOJI).toContain(p.emoji);
      expect(p.dx).toBeGreaterThanOrEqual(-1);
      expect(p.dx).toBeLessThanOrEqual(1);
      expect(p.dy).toBeGreaterThanOrEqual(0.5);
      expect(p.dy).toBeLessThanOrEqual(1);
      expect(p.delay).toBeGreaterThanOrEqual(0);
      expect(p.delay).toBeLessThanOrEqual(0.3);
    }
  });

  it('is stable for one seed and different for another', () => {
    expect(pickBurst(77, 6)).toEqual(pickBurst(77, 6));
    expect(pickBurst(77, 6)).not.toEqual(pickBurst(78, 6));
    expect(new Set(pickBurst(77, 12).map((p) => p.emoji)).size).toBeGreaterThan(3);
  });
});
