import { addDays, atTime, isoWeekday } from '../../../shared/dates.js';
import type { Day, Meeting, WeeklyMeeting } from '../types';

/** A row of a day's Meetings card: a one-off meeting, or a weekly one as it falls that day, under its title. */
export interface MeetingRow {
  uid: string;
  meeting: Meeting & { title: string };
  /** The weekly meeting's part on that day; null for a one-off. */
  weekly: WeeklyMeeting | null;
  /** A weekly meeting taken off that day: still listed, so it can be put back. */
  skipped: boolean;
}

const at = (date: string, minutes: number) => atTime(date, Math.floor(minutes / 60), minutes % 60);

/** Minutes after the local midnight of an instant, as a weekly meeting keeps its times. */
export function minuteOfDay(ms: number): number {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

/** A weekly meeting's part on `date` at its usual times. */
export function occurrence(w: WeeklyMeeting, date: string): Meeting & { title: string } {
  return { title: w.title, startsAt: at(date, w.start), endsAt: at(date, w.end) };
}

/**
 * A day's meetings by start: its one-offs, and the weekly meetings whose part is on that date, at
 * their usual times unless the day moved them. A weekly meeting's title is its own on every day.
 * A weekly one taken off the day stays, `skipped`, so it can be put back; a day's entry for a
 * weekly meeting not on that date, or gone (`title` null, or null), shows nothing.
 */
export function dayMeetings(date: string, meetings: Day['meetings'], weekly: readonly WeeklyMeeting[]): MeetingRow[] {
  const rows: MeetingRow[] = [];
  for (const w of weekly) {
    if (w.since > date || (w.until != null && w.until < date) || !w.weekdays.includes(isoWeekday(date))) continue;
    const moved = meetings[w.uid];
    rows.push({ uid: w.uid, weekly: w, skipped: moved === null, meeting: moved ? { ...moved, title: w.title } : occurrence(w, date) });
  }
  const weeklyUids = new Set(weekly.map((w) => w.uid));
  for (const [uid, m] of Object.entries(meetings)) {
    if (m?.title != null && !weeklyUids.has(uid)) rows.push({ uid, meeting: { ...m, title: m.title }, weekly: null, skipped: false });
  }
  return rows.sort((a, b) => a.meeting.startsAt - b.meeting.startsAt || a.meeting.endsAt - b.meeting.endsAt);
}

/** The part of weekly meeting `uid` that runs on (no `until`), if it still repeats. */
export function currentPart(list: readonly WeeklyMeeting[], uid: string): WeeklyMeeting | undefined {
  return list.find((w) => w.uid === uid && w.until == null);
}

/**
 * `list` with weekly meeting `uid`'s days or times changed from `today`: in place while its running
 * part starts today or later, else that part ends yesterday and a new one carries on from today
 * under the same uid, so the days before keep it as it was.
 */
export function changeWeekly(
  list: readonly WeeklyMeeting[],
  uid: string,
  patch: Partial<Pick<WeeklyMeeting, 'weekdays' | 'start' | 'end'>>,
  today: string,
): WeeklyMeeting[] {
  const part = currentPart(list, uid);
  if (!part) return [...list];
  if (part.since >= today) return list.map((w) => (w === part ? { ...w, ...patch } : w));
  return [...list.map((w) => (w === part ? { ...w, until: addDays(today, -1) } : w)), { ...part, ...patch, since: today }];
}

/** `list` with weekly meeting `uid` no longer repeating from `today`: its running part ends yesterday, or goes if it starts today or later. */
export function stopWeekly(list: readonly WeeklyMeeting[], uid: string, today: string): WeeklyMeeting[] {
  const part = currentPart(list, uid);
  if (!part) return [...list];
  return part.since >= today ? list.filter((w) => w !== part) : list.map((w) => (w === part ? { ...w, until: addDays(today, -1) } : w));
}

/** `list` with every part of weekly meeting `uid` renamed: its title is the current one on every day, as a task's is. */
export function renameWeekly(list: readonly WeeklyMeeting[], uid: string, title: string): WeeklyMeeting[] {
  return list.map((w) => (w.uid === uid ? { ...w, title } : w));
}
