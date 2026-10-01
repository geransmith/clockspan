import { describe, expect, it } from 'vitest';
import { SOUND_IDS, SOUNDS } from './sounds.js';

describe('sound catalog', () => {
  it("lists every id once, with 'none' first", () => {
    expect(new Set(SOUND_IDS).size).toBe(SOUNDS.length);
    expect(SOUND_IDS[0]).toBe('none');
  });
});
