import { describe, expect, it } from 'vitest';
import { kindForPosition } from './punches.js';

describe('kindForPosition', () => {
  it('reads even rows as in and odd rows as out', () => {
    expect([0, 1, 2, 3, 4, 5].map(kindForPosition)).toEqual(['in', 'out', 'in', 'out', 'in', 'out']);
  });
});
