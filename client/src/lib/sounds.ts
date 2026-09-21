import type { ClipId, SoundEvent } from '../../../shared/sounds.js';

/**
 * Where each bundled clip lives. One glob over the folder, so a new clip is the file plus its
 * line in `shared/sounds.ts`; the test checks the two agree. Vite hands out fingerprinted
 * `/assets/` URLs in the build (served immutable) and `/src/sounds/…` in dev.
 */
const CLIP_FILES = import.meta.glob('../sounds/*.mp3', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

export function clipUrl(id: ClipId): string {
  return CLIP_FILES[`../sounds/${id}.mp3`]!;
}

/** The ids the folder holds, for the test that keeps the catalog and the folder in step. */
export function bundledClipIds(): string[] {
  return Object.keys(CLIP_FILES)
    .map((k) => k.replace(/^\.\.\/sounds\/(.*)\.mp3$/, '$1'))
    .sort();
}

/** A row per event in Settings → Alarms → Sounds; a new event without a label is a type error. */
export const SOUND_EVENT_LABELS: Record<SoundEvent, string> = {
  timer: 'Timer finished',
  lead: 'Alarm warning',
  due: 'Alarm reached',
  overdue: 'Alarm repeat',
  dayDone: 'Day complete',
  priorityDone: 'Priority ticked',
};
