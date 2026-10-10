import { describe, expect, it } from 'vitest';
import { SOUNDS } from '../../../shared/sounds.js';
import { clipUrl } from './sounds';

describe('sound registry', () => {
  it('has a file for every clip in the catalog and a catalog line for every file', () => {
    const clips = SOUNDS.filter((s) => s.kind === 'clip').map((s) => s.id);
    expect(Object.keys(import.meta.glob('../sounds/*.mp3')).sort()).toEqual(clips.map((id) => `../sounds/${id}.mp3`).sort());
    for (const id of clips) expect(clipUrl(id)).toMatch(new RegExp(`${id}(-[\\w-]+)?\\.mp3$`));
  });
});
