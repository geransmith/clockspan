import { describe, expect, it } from 'vitest';
import type { Punch } from './api.js';
import { kindForPosition, samePunches } from './punches.js';

describe('kindForPosition', () => {
  it('reads even rows as in and odd rows as out', () => {
    expect([0, 1, 2, 3, 4, 5].map(kindForPosition)).toEqual(['in', 'out', 'in', 'out', 'in', 'out']);
  });
});

describe('samePunches', () => {
  const rows = (...at: (number | null)[]): Punch[] => at.map((t, position) => ({ position, kind: kindForPosition(position), at: t }));

  it('matches two separate copies of the same rows', () => {
    expect(samePunches(rows(1, null, null, 4), rows(1, null, null, 4))).toBe(true);
  });

  it('tells apart a time changed, rows added, or the same times on other rows', () => {
    expect(samePunches(rows(1, null, null, 4), rows(1, null, null, 5))).toBe(false);
    expect(samePunches(rows(1, null, null, 4), rows(1, null, null, 4, null, null))).toBe(false);
    const moved = rows(1, 2, null, null).map((p) => ({ ...p, position: p.position + 1 }));
    expect(samePunches(rows(1, 2, null, null), moved)).toBe(false);
  });
});
