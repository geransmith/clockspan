import type { ClipId, SoundEvent } from '../types';

/**
 * Where each bundled clip lives. One glob over the folder, so a new clip is the file plus its
 * line in `shared/sounds.ts`; the test checks the two agree. Vite hands out fingerprinted
 * `/assets/` URLs in the build (served immutable) and `/src/sounds/…` in dev.
 */
const CLIP_FILES = import.meta.glob('../sounds/*.mp3', { eager: true, query: '?url', import: 'default' });

export function clipUrl(id: ClipId): string {
  return CLIP_FILES[`../sounds/${id}.mp3`]!;
}

/** A row per event in Settings → Alarms → Sounds; a new event without a label is a type error. */
export const SOUND_EVENT_LABELS: Record<SoundEvent, string> = {
  timer: "Time's up",
  breakDone: 'Break over',
  lead: 'Alarm warning',
  due: 'Alarm reached',
  overdue: 'Alarm repeat',
  dayDone: 'Day complete',
  weekDone: 'Work week reached',
  priorityDone: 'Priority ticked',
};
