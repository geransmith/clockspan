import { describe, expect, it } from 'vitest';
import { SOUND_EVENTS, SOUNDS, type ClipId } from '../../../shared/sounds';
import { bundledClipIds, clipUrl, SOUND_EVENT_LABELS } from './sounds';

describe('sound registry', () => {
  it('has a file for every clip in the catalog and a catalog line for every file', () => {
    const clips = SOUNDS.filter((s) => s.kind === 'clip').map((s) => s.id as ClipId);
    expect(bundledClipIds()).toEqual([...clips].sort());
    for (const id of clips) expect(clipUrl(id)).toMatch(new RegExp(`${id}(-[\\w-]+)?\\.mp3$`));
  });

  it('labels every event', () => {
    for (const event of SOUND_EVENTS) expect(SOUND_EVENT_LABELS[event]).not.toBe('');
  });
});
