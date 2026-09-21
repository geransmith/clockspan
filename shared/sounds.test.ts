import { describe, expect, it } from 'vitest';
import { CLIP_IDS, SOUND_EVENTS, SOUND_IDS, SOUNDS } from './sounds.js';
import { DEFAULT_SETTINGS } from './settings.js';

describe('sound catalog', () => {
  it('lists every id once, with the clips picked out by kind', () => {
    expect(new Set(SOUND_IDS).size).toBe(SOUNDS.length);
    expect(SOUND_IDS[0]).toBe('none');
    expect(CLIP_IDS).toEqual(['yay', 'tada', 'bell', 'pop']);
    expect(SOUNDS.filter((s) => s.kind === 'synth').map((s) => s.id)).toEqual(['triad', 'taps', 'notes', 'double']);
  });

  it('gives every event a default that is in the catalog', () => {
    for (const event of SOUND_EVENTS) expect(SOUND_IDS).toContain(DEFAULT_SETTINGS.sounds[event]);
    expect(DEFAULT_SETTINGS.sounds.dayDone).toBe('yay');
  });
});
