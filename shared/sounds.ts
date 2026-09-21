/**
 * The sound catalog: everything a user can pick for an event. Pure data, imported by the
 * server (`mergeSettings` validates ids against it) and the client (the settings dialog lists
 * it, `alerts.ts` plays it). A `clip` is a bundled file at `client/src/sounds/<id>.mp3`; a
 * `synth` is a `beep()` pattern in `client/src/lib/alerts.ts`. Adding a clip is the file plus
 * one line here (see "How to add… a sound" in AGENTS.md).
 */
export const SOUNDS = [
  { id: 'none', label: 'None', kind: 'none' },
  { id: 'triad', label: 'Rising chime', kind: 'synth' },
  { id: 'taps', label: 'Two taps', kind: 'synth' },
  { id: 'notes', label: 'Three notes', kind: 'synth' },
  { id: 'double', label: 'Low double', kind: 'synth' },
  { id: 'yay', label: 'Yay!', kind: 'clip' },
  { id: 'tada', label: 'Ta-da', kind: 'clip' },
  { id: 'bell', label: 'Bell', kind: 'clip' },
  { id: 'pop', label: 'Pop', kind: 'clip' },
] as const;

export type Sound = (typeof SOUNDS)[number];
export type SoundId = Sound['id'];
export type ClipId = Extract<Sound, { kind: 'clip' }>['id'];
export type SynthId = Extract<Sound, { kind: 'synth' }>['id'];

export const SOUND_IDS: readonly SoundId[] = SOUNDS.map((s) => s.id);
export const CLIP_IDS: readonly ClipId[] = SOUNDS.filter((s): s is Extract<Sound, { kind: 'clip' }> => s.kind === 'clip').map((s) => s.id);

/**
 * What can make a noise. The alarm stages share their names with `AlarmKind`
 * (`client/src/lib/alarms.ts`) so a fired event's sound is `settings.sounds[event.kind]`.
 */
export const SOUND_EVENTS = ['timer', 'lead', 'due', 'overdue', 'dayDone', 'priorityDone'] as const;
export type SoundEvent = (typeof SOUND_EVENTS)[number];
