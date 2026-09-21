import { describe, expect, it } from 'vitest';
import { CLIP_IDS, SOUND_EVENTS } from '../../../shared/sounds';
import { bundledClipIds, clipUrl, SOUND_EVENT_LABELS } from './sounds';

describe('sound registry', () => {
  it('has a file for every clip in the catalog and a catalog line for every file', () => {
    expect(bundledClipIds()).toEqual([...CLIP_IDS].sort());
    for (const id of CLIP_IDS) expect(clipUrl(id)).toMatch(new RegExp(`${id}(-[\\w-]+)?\\.mp3$`));
  });

  it('labels every event', () => {
    for (const event of SOUND_EVENTS) expect(SOUND_EVENT_LABELS[event]).not.toBe('');
  });
});
