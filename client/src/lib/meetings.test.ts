import { describe, expect, it } from 'vitest';
import { atTime, HOUR_MS, MINUTE_MS } from '../../../shared/dates.js';
import type { WeeklyMeeting } from '../types';
import { changeWeekly, currentPart, dayMeetings, defaultUntil, meetingAt, minuteOfDay, nextMeeting, occurrence, renameWeekly, stopWeekly } from './meetings';

// 2026-10-12 is a Monday.
const MON = '2026-10-12';
const TUE = '2026-10-13';
const at = (date: string, h: number, m = 0) => atTime(date, h, m);
const STANDUP: WeeklyMeeting = { uid: 'stand000', title: 'Standup', weekdays: [1, 2, 3, 4, 5], start: 570, end: 585, since: '2026-10-01', until: null };
const call = (h: number, title = 'Call') => ({ title, startsAt: at(MON, h), endsAt: at(MON, h) + HOUR_MS });

describe('dayMeetings', () => {
  it('lists the one-offs and the weekly meetings on the date by start, at their usual times', () => {
    const late = { ...call(9), endsAt: at(MON, 12) };
    expect(dayMeetings(MON, { b: late, a: call(9), c: call(10), gone: null }, [STANDUP])).toEqual([
      { uid: 'a', meeting: call(9), weekly: null, skipped: false },
      { uid: 'b', meeting: late, weekly: null, skipped: false },
      { uid: 'stand000', meeting: { title: 'Standup', startsAt: at(MON, 9, 30), endsAt: at(MON, 9, 45) }, weekly: STANDUP, skipped: false },
      { uid: 'c', meeting: call(10), weekly: null, skipped: false },
    ]);
    expect(dayMeetings(MON, {}, [])).toEqual([]);
  });

  it("leaves out a weekly meeting off its days, before its start or after its end, and shows the day's key for none of them", () => {
    const moved = { stand000: call(11, '') };
    expect(dayMeetings('2026-10-17', moved, [STANDUP])).toEqual([]); // a Saturday
    expect(dayMeetings(MON, moved, [{ ...STANDUP, since: TUE }])).toEqual([]);
    expect(dayMeetings(MON, moved, [{ ...STANDUP, until: '2026-10-11' }])).toEqual([]);
    expect(dayMeetings(MON, {}, [{ ...STANDUP, until: MON }])).toHaveLength(1);
  });

  it("shows nothing for a weekly meeting's own times on a day once the weekly meeting is gone", () => {
    expect(dayMeetings(MON, { stand000: { ...call(11), title: null }, gone0000: null, untitled: call(12, '') }, [])).toEqual([
      { uid: 'untitled', meeting: call(12, ''), weekly: null, skipped: false },
    ]);
  });

  it("takes a weekly meeting's times from the day that moved it, under the meeting's own title, and keeps one skipped there", () => {
    expect(dayMeetings(MON, { stand000: { ...call(11), title: null } }, [STANDUP])[0]).toEqual({
      uid: 'stand000',
      meeting: { ...call(11), title: 'Standup' },
      weekly: STANDUP,
      skipped: false,
    });
    expect(dayMeetings(MON, { stand000: null }, [STANDUP])[0]).toEqual({ uid: 'stand000', meeting: occurrence(STANDUP, MON), weekly: STANDUP, skipped: true });
  });

  it('shows the part of a weekly meeting that is on the date', () => {
    const before = { ...STANDUP, until: '2026-10-11' };
    const after = { ...STANDUP, start: 600, end: 615, since: MON };
    expect(dayMeetings('2026-10-09', {}, [before, after])[0]!.meeting.startsAt).toBe(at('2026-10-09', 9, 30));
    expect(dayMeetings(MON, {}, [before, after])[0]!.meeting.startsAt).toBe(at(MON, 10));
  });
});

describe('minuteOfDay and occurrence', () => {
  it('read a weekly meeting as minutes of the local day, also across a DST change', () => {
    expect(minuteOfDay(at(MON, 9, 30))).toBe(570);
    expect(occurrence(STANDUP, '2026-11-02')).toEqual({ title: 'Standup', startsAt: at('2026-11-02', 9, 30), endsAt: at('2026-11-02', 9, 45) });
    expect(minuteOfDay(at('2026-11-01', 9, 30))).toBe(570);
  });
});

describe('changeWeekly, stopWeekly and renameWeekly', () => {
  const TODAY = MON;

  it('ends the running part yesterday and carries on from today under the same uid, so the days before keep it', () => {
    const next = changeWeekly([STANDUP], 'stand000', { weekdays: [1, 3] }, TODAY);
    expect(next).toEqual([
      { ...STANDUP, until: '2026-10-11' },
      { ...STANDUP, weekdays: [1, 3], since: TODAY },
    ]);
    expect(currentPart(next, 'stand000')).toEqual({ ...STANDUP, weekdays: [1, 3], since: TODAY });
    // The part from today changes in place.
    expect(changeWeekly(next, 'stand000', { start: 600, end: 615 }, TODAY)).toEqual([next[0], { ...next[1], start: 600, end: 615 }]);
  });

  it('leaves the other weekly meetings as they are', () => {
    const other = { ...STANDUP, uid: 'other000' };
    expect(changeWeekly([other, STANDUP], 'stand000', { start: 600 }, TODAY)).toEqual([
      other,
      { ...STANDUP, until: '2026-10-11' },
      { ...STANDUP, start: 600, since: TODAY },
    ]);
    expect(stopWeekly([other, STANDUP], 'stand000', TODAY)).toEqual([other, { ...STANDUP, until: '2026-10-11' }]);
  });

  it('changes nothing for a weekly meeting that no longer repeats', () => {
    const ended = [{ ...STANDUP, until: '2026-10-05' }];
    expect(changeWeekly(ended, 'stand000', { weekdays: [1] }, TODAY)).toEqual(ended);
    expect(stopWeekly(ended, 'stand000', TODAY)).toEqual(ended);
  });

  it('stops one that started before today from today, and drops one that starts today or later', () => {
    expect(stopWeekly([STANDUP], 'stand000', TODAY)).toEqual([{ ...STANDUP, until: '2026-10-11' }]);
    expect(stopWeekly([{ ...STANDUP, since: TODAY }], 'stand000', TODAY)).toEqual([]);
  });

  it('renames every part, so the title is the current one on every day', () => {
    const parts = [
      { ...STANDUP, until: '2026-10-11' },
      { ...STANDUP, since: TODAY },
      { ...STANDUP, uid: 'other000' },
    ];
    expect(renameWeekly(parts, 'stand000', 'Daily').map((w) => w.title)).toEqual(['Daily', 'Daily', 'Standup']);
  });
});

describe('defaultUntil', () => {
  it('is the first :00 or :30 at least 10 minutes away', () => {
    expect(defaultUntil(at(MON, 9))).toBe(at(MON, 9, 30));
    expect(defaultUntil(at(MON, 9, 20))).toBe(at(MON, 9, 30));
    expect(defaultUntil(at(MON, 9, 20) + 1)).toBe(at(MON, 10));
    expect(defaultUntil(at(MON, 9, 50))).toBe(at(MON, 10));
    expect(defaultUntil(at(MON, 9, 45))).toBe(at(MON, 10));
  });
});

describe('meetingAt', () => {
  it('finds the meeting on at a time, the first by start, leaving out a skipped one', () => {
    const rows = dayMeetings(MON, { a: call(9), b: call(9, 'Second'), stand000: null }, [{ ...STANDUP, start: 540, end: 600 }]);
    expect(meetingAt(rows, at(MON, 9, 30))?.uid).toBe('a');
    expect(meetingAt(rows, at(MON, 10))).toBeNull();
    expect(meetingAt(rows, at(MON, 9) - MINUTE_MS)).toBeNull();
  });
});

describe('nextMeeting', () => {
  it('finds the first meeting to start after a time, leaving out a skipped one', () => {
    const rows = dayMeetings(MON, { a: call(9), c: call(11), stand000: null }, [{ ...STANDUP, start: 600, end: 615 }]);
    expect(nextMeeting(rows, at(MON, 8))?.uid).toBe('a');
    expect(nextMeeting(rows, at(MON, 9))?.uid).toBe('c');
    expect(nextMeeting(rows, at(MON, 11))).toBeNull();
  });
});
