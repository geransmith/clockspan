import type { Day, Meeting } from '../types';

/** A day's meetings by start, each with its uid; the ones taken off the day left out. */
export function dayMeetings(meetings: Day['meetings']): [uid: string, meeting: Meeting][] {
  return Object.entries(meetings)
    .filter((e): e is [string, Meeting] => e[1] != null)
    .sort(([, a], [, b]) => a.startsAt - b.startsAt || a.endsAt - b.endsAt);
}
