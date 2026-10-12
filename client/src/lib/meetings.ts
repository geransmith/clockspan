import { addDays, atTime, isoWeekday, MINUTE_MS } from '../../../shared/dates.js';
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

/** The furthest the timer card's Meeting runs to: a wrong Until holds the break alarm no longer than this. */
export const MEETING_UNTIL_MAX_MINUTES = 4 * 60;

/** Until's first value for a meeting started at `now`: the first :00 or :30 at least 10 minutes away. */
export function defaultUntil(now: number): number {
  const d = new Date(Math.ceil((now + 10 * MINUTE_MS) / MINUTE_MS) * MINUTE_MS);
  const m = d.getMinutes();
  d.setMinutes(m === 0 ? 0 : m <= 30 ? 30 : 60);
  return d.getTime();
}

/** The meeting on at `now` among a day's rows, the first by start, skipped ones aside; null with none. */
export function meetingAt(rows: readonly MeetingRow[], now: number): MeetingRow | null {
  return rows.find((r) => !r.skipped && r.meeting.startsAt <= now && now < r.meeting.endsAt) ?? null;
}

/** The next meeting to start after `now` among a day's rows, skipped ones aside; null with none left. */
export function nextMeeting(rows: readonly MeetingRow[], now: number): MeetingRow | null {
  return rows.find((r) => !r.skipped && r.meeting.startsAt > now) ?? null;
}

/** A meeting on at the lunch deadline, and the latest Lunch out that is back before it starts. */
export interface LunchClash {
  meeting: MeetingRow['meeting'];
  by: number;
}

/**
 * The first meeting on at the lunch deadline (`lunchBy`), skipped ones aside, with `by`, the latest
 * Lunch out a lunch of `lunchMinutes` comes back from before it starts; null with none, or with no
 * deadline (no lunch needed, or meal periods off).
 */
export function lunchClash(lunchBy: number | null, rows: readonly MeetingRow[], lunchMinutes: number): LunchClash | null {
  if (lunchBy == null) return null;
  const row = rows.find((r) => !r.skipped && r.meeting.startsAt <= lunchBy && lunchBy < r.meeting.endsAt);
  return row ? { meeting: row.meeting, by: row.meeting.startsAt - lunchMinutes * MINUTE_MS } : null;
}

/**
 * How many of a day's meetings (`dayMeetings`, by start) began before `until`, skipped ones aside,
 * and their time up to it, an overlap counted once.
 */
export function meetingTime(rows: readonly MeetingRow[], until: number): { count: number; seconds: number } {
  let count = 0;
  let ms = 0;
  let reached = -Infinity;
  for (const { meeting, skipped } of rows) {
    const end = Math.min(meeting.endsAt, until);
    if (skipped || meeting.startsAt >= end) continue;
    count++;
    ms += Math.max(0, end - Math.max(meeting.startsAt, reached));
    reached = Math.max(reached, end);
  }
  return { count, seconds: Math.round(ms / 1000) };
}
