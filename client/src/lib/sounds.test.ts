import { describe, expect, it } from 'vitest';
import { SOUNDS } from '../../../shared/sounds.js';
import { bundledClipIds, clipUrl } from './sounds';

describe('sound registry', () => {
  it('has a file for every clip in the catalog and a catalog line for every file', () => {
    const clips = SOUNDS.filter((s) => s.kind === 'clip').map((s) => s.id);
    expect(bundledClipIds()).toEqual([...clips].sort());
    for (const id of clips) expect(clipUrl(id)).toMatch(new RegExp(`${id}(-[\\w-]+)?\\.mp3$`));
  });
});
