import { describe, expect, it } from 'vitest';
import { HOUR_MS, MINUTE_MS } from '../../../shared/dates.js';
import { makeBreak, makeDay, makeSession, punchesAt, T0, TEST_SETTINGS, TODAY } from '../test/fixtures';
import {
  alarmTargets,
  describeEvent,
  describeSnooze,
  dueEvents,
  eventKey,
  missedClockIn,
  SNOOZE_MINUTES,
  type AlarmEvent,
  type AlarmTarget,
  type TargetDay,
} from './alarms';
import { formatTime } from './format';
import { patchCard } from './layout';
import { computeTimeclock } from './timeclock';
import type { AlarmId, AlarmSettings, Settings } from '../types';

const T = new Date(2026, 8, 16, 13, 0).getTime();
const alarms = (clock: Partial<AlarmSettings> = {}) => ({ ...TEST_SETTINGS.alarms, clockOut: { ...TEST_SETTINGS.alarms.clockOut, ...clock } });
const target = (at: number, id: AlarmId = 'clockOut', armed = true): AlarmTarget => ({ id, at, armed });

describe('dueEvents', () => {
  it('fires nothing before the first lead', () => {
    const r = dueEvents([target(T)], alarms(), new Set(), T - 20 * MINUTE_MS);
    expect(r.fire).toEqual([]);
    expect(r.crossed).toEqual([]);
  });

  it('fires a lead exactly when crossed and reports it as crossed', () => {
    const r = dueEvents([target(T)], alarms(), new Set(), T - 15 * MINUTE_MS);
    expect(r.fire.map((e) => [e.kind, e.minutes])).toEqual([['lead', 15]]);
    expect(r.crossed).toEqual([eventKey('clockOut', 'lead', 15, T)]);
  });

  it('does not re-fire an event already recorded as fired', () => {
    const fired = new Set([eventKey('clockOut', 'lead', 15, T)]);
    const r = dueEvents([target(T)], alarms(), fired, T - 14 * MINUTE_MS);
    expect(r.fire).toEqual([]);
  });

  it('fires the due event at the target', () => {
    const fired = new Set([15, 5, 1].map((m) => eventKey('clockOut', 'lead', m, T)));
    const r = dueEvents([target(T)], alarms(), fired, T);
    expect(r.fire.map((e) => e.kind)).toEqual(['due']);
  });

  it('repeats while overdue at the configured interval', () => {
    const fired = new Set([...[15, 5, 1].map((m) => eventKey('clockOut', 'lead', m, T)), eventKey('clockOut', 'due', 0, T)]);
    expect(dueEvents([target(T)], alarms(), fired, T + 4 * MINUTE_MS).fire).toEqual([]);
    const r = dueEvents([target(T)], alarms(), fired, T + 5 * MINUTE_MS);
    expect(r.fire.map((e) => [e.kind, e.minutes])).toEqual([['overdue', 5]]);
    fired.add(r.crossed[0]!);
    const r2 = dueEvents([target(T)], alarms(), fired, T + 10 * MINUTE_MS);
    expect(r2.fire.map((e) => [e.kind, e.minutes])).toEqual([['overdue', 10]]);
  });

  it('collapses a catch-up burst to the latest event and marks what was crossed', () => {
    // Phone slept from T-20m to T+7m: leads 15/5/1, due and overdue 5 all crossed.
    const r = dueEvents([target(T)], alarms(), new Set(), T + 7 * MINUTE_MS);
    expect(r.fire.map((e) => [e.kind, e.minutes])).toEqual([['overdue', 5]]);
    expect(r.crossed).toHaveLength(5);
  });

  it('keeps repeating every minute however long the day runs over', () => {
    const a = alarms({ overdueEveryMinutes: 1 });
    const r = dueEvents([target(T)], a, new Set(), T + 300 * MINUTE_MS);
    expect(r.fire.map((e) => [e.kind, e.minutes])).toEqual([['overdue', 300]]);
    const fired = new Set(r.crossed);
    expect(dueEvents([target(T)], a, fired, T + 301 * MINUTE_MS).fire.map((e) => [e.kind, e.minutes])).toEqual([['overdue', 301]]);
  });

  it('re-arms when the target moves later', () => {
    const fired = new Set<string>();
    const first = dueEvents([target(T)], alarms(), fired, T - 15 * MINUTE_MS);
    first.crossed.forEach((k) => fired.add(k));
    // Lunch ran long; clock-out is now 20 minutes later. The 15-minute lead is 5 minutes away again.
    const moved = T + 20 * MINUTE_MS;
    expect(dueEvents([target(moved)], alarms(), fired, T - 14 * MINUTE_MS).fire).toEqual([]);
    const again = dueEvents([target(moved)], alarms(), fired, moved - 15 * MINUTE_MS);
    expect(again.fire.map((e) => [e.kind, e.minutes])).toEqual([['lead', 15]]);
  });

  it('ignores disarmed targets and disabled alarms', () => {
    expect(dueEvents([target(T, 'clockOut', false)], alarms(), new Set(), T).fire).toEqual([]);
    expect(dueEvents([target(T)], alarms({ enabled: false }), new Set(), T).fire).toEqual([]);
  });

  it('honours onDue=false and overdueEveryMinutes=0', () => {
    const a = alarms({ leadMinutes: [], onDue: false, overdueEveryMinutes: 0 });
    expect(dueEvents([target(T)], a, new Set(), T + 60 * MINUTE_MS).fire).toEqual([]);
  });

  it('handles each target independently', () => {
    const r = dueEvents([target(T, 'lunchBy'), target(T + 3 * HOUR_MS, 'clockOut'), target(T + 15 * MINUTE_MS, 'secondMeal')], alarms(), new Set(), T);
    expect(r.fire.map((e) => [e.id, e.kind])).toEqual([
      ['lunchBy', 'due'],
      ['secondMeal', 'lead'],
    ]);
  });

  describe('a snooze', () => {
    // Pressed `SNOOZE_MINUTES` before it ends.
    const snoozedAt = (press: number) => press + SNOOZE_MINUTES * MINUTE_MS;
    const fires = (r: ReturnType<typeof dueEvents>) => r.fire.map((e) => [e.id, e.kind, e.minutes]);

    it('quiets only its own alarm, firing and crossing nothing until its time, while another past due rings on', () => {
      const both = [target(T, 'lunchBy'), target(T)];
      const snooze = { lunchBy: snoozedAt(T + MINUTE_MS) };
      const r = dueEvents(both, alarms(), new Set(), T + 5 * MINUTE_MS, snooze);
      expect(fires(r)).toEqual([['clockOut', 'overdue', 5]]);
      expect(r.crossed.every((k) => k.startsWith('clockOut:'))).toBe(true);
      expect(r.snoozed).toEqual([target(T, 'lunchBy')]);
      const fired = new Set(r.crossed);
      const later = dueEvents(both, alarms(), fired, T + 10 * MINUTE_MS, snooze);
      expect(fires(later)).toEqual([['clockOut', 'overdue', 10]]);
      expect(later.snoozed).toEqual([target(T, 'lunchBy')]);
    });

    it.each([1, 5, 10, 60])('rings once at its time, then a full %i min repeat apart from it', (every) => {
      const a = alarms({ overdueEveryMinutes: every });
      // Pressed 6 s before the first repeat: 4:54 past the deadline for a 5 min repeat.
      const press = T + every * MINUTE_MS - 6_000;
      const fired = new Set(dueEvents([target(T)], a, new Set(), press).crossed);
      const until = snoozedAt(press);
      const snooze = { clockOut: until };
      const before = dueEvents([target(T)], a, fired, until - 1, snooze);
      expect([before.fire, before.crossed]).toEqual([[], []]);

      const ring = dueEvents([target(T)], a, fired, until, snooze);
      // Whole minutes past the deadline: 19 for the 5 min repeat, rung at 19:54.
      const m = every + SNOOZE_MINUTES - 1;
      expect(fires(ring)).toEqual([['clockOut', 'overdue', m]]);
      expect(ring.snoozed).toEqual([]);
      for (const k of ring.crossed) fired.add(k);
      // Nothing on the deadline's own beat (20:00), nor before the next.
      expect(dueEvents([target(T)], a, fired, T + (m + 1) * MINUTE_MS, snooze).fire).toEqual([]);
      expect(dueEvents([target(T)], a, fired, until + every * MINUTE_MS - 1, snooze).fire).toEqual([]);
      expect(fires(dueEvents([target(T)], a, fired, until + every * MINUTE_MS, snooze))).toEqual([['clockOut', 'overdue', m + every]]);
    });

    it('takes a second press after its ring and a repeat, ringing once at the new time with a key of its own', () => {
      const fired = new Set(dueEvents([target(T)], alarms(), new Set(), T + 4 * MINUTE_MS + 54_000).crossed);
      const first = { clockOut: snoozedAt(T + 4 * MINUTE_MS + 54_000) };
      for (const now of [first.clockOut, first.clockOut + 5 * MINUTE_MS]) {
        for (const k of dueEvents([target(T)], alarms(), fired, now, first).crossed) fired.add(k);
      }
      // The repeat at 24:54 was the last; pressed again at 26:00.
      const second = { clockOut: snoozedAt(T + 26 * MINUTE_MS) };
      const quiet = dueEvents([target(T)], alarms(), fired, second.clockOut - 1, second);
      expect([quiet.fire, quiet.crossed, quiet.snoozed]).toEqual([[], [], [target(T)]]);
      const ring = dueEvents([target(T)], alarms(), fired, second.clockOut, second);
      expect(fires(ring)).toEqual([['clockOut', 'overdue', 41]]);
      expect(fired.has(ring.fire[0]!.key)).toBe(false);
    });

    it('lets a deadline moved past the press ring on its new schedule', () => {
      const press = T + 3 * MINUTE_MS;
      const fired = new Set(dueEvents([target(T)], alarms(), new Set(), press).crossed);
      const snooze = { clockOut: snoozedAt(press) };
      // An Out / In pushed the end to 9 min past the old one, after the press.
      const moved = T + 9 * MINUTE_MS;
      const r = dueEvents([target(moved)], alarms(), fired, moved, snooze);
      expect(fires(r)).toEqual([['clockOut', 'due', 0]]);
      expect(r.snoozed).toEqual([]);
    });

    it('never covers the retrospective or an alarm whose Repeat is off', () => {
      const retro = { ...alarms(), retro: { ...TEST_SETTINGS.alarms.retro, overdueEveryMinutes: 5 } };
      const r = dueEvents([target(T, 'retro')], retro, new Set(), T + 5 * MINUTE_MS, { retro: snoozedAt(T) });
      expect([fires(r), r.snoozed]).toEqual([[['retro', 'overdue', 5]], []]);
      const once = dueEvents([target(T)], alarms({ overdueEveryMinutes: 0 }), new Set(), T, { clockOut: snoozedAt(T) });
      expect([fires(once), once.snoozed]).toEqual([[['clockOut', 'due', 0]], []]);
    });
  });
});

describe('describeSnooze', () => {
  const until = T + 15 * MINUTE_MS;
  // A deadline 1h 20m and 30 s past, or 30 s past.
  const late = { now: T + 80.5 * MINUTE_MS };
  const justNow = { now: T + 30_000 };
  const lines: [AlarmId, string, string, string][] = [
    ['lunchBy', 'Lunch alarm', 'Lunch is 1h 20m overdue.', 'Take lunch now.'],
    ['secondMeal', 'Second meal alarm', 'Second meal period is 1h 20m overdue.', 'Take your second meal period.'],
    ['clockOut', 'Clock-out alarm', 'Clock-out is 1h 20m overdue.', 'Time to clock out.'],
    ['lunchEnd', 'Lunch end alarm', 'Lunch ended 1h 20m ago.', 'Lunch is over.'],
    // Counted from the last rest, 90 min before its deadline.
    ['noBreak', 'Break alarm', '2h 50m without a break.', '1h 30m without a break.'],
  ];

  it.each(lines)('words %s in 12-hour and 24-hour time, flooring the minutes', (id, kicker, overdue, due) => {
    for (const hour12 of [true, false]) {
      const time = formatTime(until, hour12);
      expect(describeSnooze(target(T, id), until, { ...late, hour12 })).toEqual({
        kicker,
        title: `Snoozed Until ${time}`,
        body: `${overdue} It rings again at ${time}.`,
      });
      expect(describeSnooze(target(T, id), until, { ...justNow, hour12 }).body).toBe(`${due} It rings again at ${time}.`);
    }
  });
});

describe('alarmTargets', () => {
  // 8:00 clock-in, an 8 h day, lunch by 1 PM, a second meal after 10 h, every card shown.
  const s = TEST_SETTINGS;
  const IN = new Date(2026, 8, 16, 8, 0).getTime();
  const day = { overtimeApproved: false, retroDone: false, breaks: [], timerRunning: false };
  const tc = (now: number, ...at: (number | null)[]) => computeTimeclock(punchesAt(...at), s, now);
  const armed = (targets: AlarmTarget[]) => Object.fromEntries(targets.map((t) => [t.id, t.armed]));

  it('has nothing armed before clock-in', () => {
    const targets = alarmTargets(tc(IN), s, day, IN);
    expect(targets).toEqual([
      { id: 'lunchBy', at: 0, armed: false },
      { id: 'lunchEnd', at: 0, armed: false },
      { id: 'clockOut', at: 0, armed: false },
      { id: 'secondMeal', at: 0, armed: false },
      { id: 'retro', at: 0, armed: false },
      { id: 'noBreak', at: 0, armed: false },
    ]);
  });

  it('arms lunch, clock-out, the retrospective and the break alarm while working before lunch, and lunch while it is overdue', () => {
    const now = tc(IN + 2 * HOUR_MS, IN);
    const targets = alarmTargets(now, s, day, IN + 2 * HOUR_MS);
    expect(targets.map((t) => t.at)).toEqual([IN + 5 * HOUR_MS, 0, now.clockOutAt, now.secondMealBy, now.clockOutAt, IN + 90 * MINUTE_MS]);
    // An 8 h day never reaches the 10 h second meal.
    expect(armed(targets)).toEqual({ lunchBy: true, lunchEnd: false, clockOut: true, secondMeal: false, retro: true, noBreak: true });
    expect(armed(alarmTargets(tc(IN + 5 * HOUR_MS + 10 * MINUTE_MS, IN), s, day, IN + 5 * HOUR_MS + 10 * MINUTE_MS)).lunchBy).toBe(true);
  });

  it('rings the clock-out warnings before the end of a day whose lunch was never taken', () => {
    const fired = new Set<string>();
    const rang: AlarmEvent[] = [];
    for (let now = IN + 4 * HOUR_MS; now <= IN + 8 * HOUR_MS; now += MINUTE_MS) {
      // The lunch alarm repeats all afternoon.
      const r = dueEvents(
        alarmTargets(tc(now, IN), s, day, now).filter((t) => t.id !== 'lunchBy'),
        s.alarms,
        fired,
        now,
      );
      r.crossed.forEach((k) => fired.add(k));
      rang.push(...r.fire);
    }
    expect(rang.map((e) => [e.id, e.kind, e.minutes])).toEqual([
      ['retro', 'lead', 30],
      ['clockOut', 'lead', 15],
      ['clockOut', 'lead', 5],
      ['clockOut', 'lead', 1],
      ['clockOut', 'due', 0],
    ]);
  });

  it('has no lunch alarm on a day short enough to need no lunch', () => {
    // A 4 h day, 50 min over, is still inside the 5 h lunch window; being over brings the second meal in.
    const half = { ...s, workMinutes: 240 };
    const short = computeTimeclock(punchesAt(IN), half, IN + 4 * HOUR_MS + 50 * MINUTE_MS);
    expect(short.lunchStatus).toBe('not-needed');
    // The clock-out deadline 50 min past holds the break alarm.
    expect(armed(alarmTargets(short, half, day, IN + 4 * HOUR_MS + 50 * MINUTE_MS))).toEqual({
      lunchBy: false,
      lunchEnd: false,
      clockOut: true,
      secondMeal: true,
      retro: true,
      noBreak: false,
    });
  });

  it('disarms clock-out, the retrospective and the break alarm at lunch, where the end of the day drifts, and lunch once taken', () => {
    expect(armed(alarmTargets(tc(IN + 4 * HOUR_MS + 10 * MINUTE_MS, IN, IN + 4 * HOUR_MS), s, day, IN + 4 * HOUR_MS + 10 * MINUTE_MS))).toEqual({
      lunchBy: false,
      lunchEnd: true,
      clockOut: false,
      secondMeal: false,
      retro: false,
      noBreak: false,
    });
    const back = tc(IN + 5 * HOUR_MS, IN, IN + 4 * HOUR_MS, IN + 4 * HOUR_MS + 30 * MINUTE_MS);
    expect(armed(alarmTargets(back, s, day, IN + 5 * HOUR_MS))).toEqual({
      lunchBy: false,
      lunchEnd: false,
      clockOut: true,
      secondMeal: false,
      retro: true,
      noBreak: true,
    });
  });

  it('arms the end of lunch only at lunch, at Lunch out plus the lunch length', () => {
    const lunchEnd = (t: ReturnType<typeof tc>, now: number) => alarmTargets(t, s, day, now).find((x) => x.id === 'lunchEnd');
    expect(lunchEnd(tc(IN + 4 * HOUR_MS + 10 * MINUTE_MS, IN, IN + 4 * HOUR_MS), IN + 4 * HOUR_MS + 10 * MINUTE_MS)).toEqual({
      id: 'lunchEnd',
      at: IN + 4.5 * HOUR_MS,
      armed: true,
    });
    // A Clock out typed ahead keeps clock-out and the retrospective off at lunch, as the repeat's body says.
    expect(armed(alarmTargets(tc(IN + 5 * HOUR_MS, IN, IN + 4 * HOUR_MS, null, IN + 9 * HOUR_MS), s, day, IN + 5 * HOUR_MS))).toEqual({
      lunchBy: false,
      lunchEnd: true,
      clockOut: false,
      secondMeal: false,
      retro: false,
      noBreak: false,
    });
  });

  it('rings the end of lunch when it is reached, then every 15 minutes, and nothing before', () => {
    const fired = new Set<string>();
    const rang: AlarmEvent[] = [];
    // Lunch out at 12:00 and Lunch in never punched, through to 1:05 PM.
    for (let now = IN + 4 * HOUR_MS; now <= IN + 5 * HOUR_MS + 5 * MINUTE_MS; now += MINUTE_MS) {
      const r = dueEvents(alarmTargets(tc(now, IN, IN + 4 * HOUR_MS), s, day, now), s.alarms, fired, now);
      r.crossed.forEach((k) => fired.add(k));
      rang.push(...r.fire);
    }
    // The lunch deadline is 1 PM, but lunch was taken: only the end of lunch rings.
    expect(rang.map((e) => [e.id, e.kind, e.minutes, e.at])).toEqual([
      ['lunchEnd', 'due', 0, IN + 4.5 * HOUR_MS],
      ['lunchEnd', 'overdue', 15, IN + 4.75 * HOUR_MS],
      ['lunchEnd', 'overdue', 30, IN + 5 * HOUR_MS],
    ]);
  });

  it('with overtime approved, silences only clock-out, and the second meal comes due', () => {
    expect(armed(alarmTargets(tc(IN + 2 * HOUR_MS, IN), s, { ...day, overtimeApproved: true }, IN + 2 * HOUR_MS))).toEqual({
      lunchBy: true,
      lunchEnd: false,
      clockOut: false,
      secondMeal: true,
      retro: true,
      noBreak: true,
    });
  });

  it('waits for punches out of order to be fixed before the end of the day or the second meal ring', () => {
    // Clock out typed before Lunch out: the timeclock reads "working" while the day is over.
    const tangled = tc(IN + 9 * HOUR_MS, IN, IN + 8 * HOUR_MS + 25 * MINUTE_MS, null, IN + 8 * HOUR_MS + 20 * MINUTE_MS);
    expect([tangled.outOfOrder, tangled.state]).toEqual([{ position: 3, after: 1 }, 'working']);
    expect(armed(alarmTargets(tangled, s, { ...day, overtimeApproved: true }, IN + 9 * HOUR_MS))).toEqual({
      lunchBy: false,
      lunchEnd: false,
      clockOut: false,
      secondMeal: false,
      retro: false,
      noBreak: false,
    });
  });

  it('arms the end of the day with Lunch out and the Clock out typed ahead, which wait for the clock', () => {
    expect(armed(alarmTargets(tc(IN + 2 * HOUR_MS, IN, IN + 4 * HOUR_MS, null, IN + 9 * HOUR_MS), s, day, IN + 2 * HOUR_MS))).toEqual({
      lunchBy: true,
      lunchEnd: false,
      clockOut: true,
      secondMeal: false,
      retro: true,
      noBreak: true,
    });
  });

  it('moves clock-out and the retrospective to a Clock out typed earlier than the planned end, never later', () => {
    const back = [IN, IN + 4 * HOUR_MS, IN + 4.5 * HOUR_MS] as const;
    const early = alarmTargets(tc(IN + 5 * HOUR_MS, ...back, IN + 7 * HOUR_MS), s, day, IN + 5 * HOUR_MS);
    expect(early.filter((t) => t.id === 'clockOut' || t.id === 'retro')).toEqual([
      { id: 'clockOut', at: IN + 7 * HOUR_MS, armed: true },
      { id: 'retro', at: IN + 7 * HOUR_MS, armed: true },
    ]);
    const late = tc(IN + 5 * HOUR_MS, ...back, IN + 9 * HOUR_MS);
    const lateEnds = alarmTargets(late, s, day, IN + 5 * HOUR_MS).filter((t) => t.id === 'clockOut' || t.id === 'retro');
    expect(late.clockOutAt).toBe(IN + 8.5 * HOUR_MS);
    expect(lateEnds.map((t) => t.at)).toEqual([late.clockOutAt, late.clockOutAt]);
  });

  it('rings only the warnings before a Clock out typed earlier than the planned end', () => {
    const fired = new Set<string>();
    const rang: AlarmEvent[] = [];
    // Lunch 12:00 to 12:30 and a Clock out typed for 15:00, through to past the 16:30 planned end.
    for (let now = IN + 5 * HOUR_MS; now <= IN + 9 * HOUR_MS; now += MINUTE_MS) {
      const r = dueEvents(alarmTargets(tc(now, IN, IN + 4 * HOUR_MS, IN + 4.5 * HOUR_MS, IN + 7 * HOUR_MS), s, day, now), s.alarms, fired, now);
      r.crossed.forEach((k) => fired.add(k));
      rang.push(...r.fire);
    }
    expect(rang.map((e) => [e.id, e.kind, e.minutes, e.at])).toEqual([
      ['retro', 'lead', 30, IN + 6.5 * HOUR_MS],
      ['clockOut', 'lead', 15, IN + 7 * HOUR_MS - 15 * MINUTE_MS],
      ['clockOut', 'lead', 5, IN + 7 * HOUR_MS - 5 * MINUTE_MS],
      ['clockOut', 'lead', 1, IN + 7 * HOUR_MS - MINUTE_MS],
    ]);
  });

  it('keeps lunch armed with the punches out of order, since its deadline comes from the clock-in', () => {
    // Mid-morning, no lunch yet, and a Clock out typed as 2:00 AM: the typo must not mute the meal period.
    const typo = tc(IN + 3 * HOUR_MS, IN, null, null, IN - 6 * HOUR_MS);
    expect([typo.outOfOrder, typo.state, typo.lunchStatus]).toEqual([{ position: 3, after: 0 }, 'working', 'upcoming']);
    expect(armed(alarmTargets(typo, s, day, IN + 3 * HOUR_MS))).toEqual({
      lunchBy: true,
      lunchEnd: false,
      clockOut: false,
      secondMeal: false,
      retro: false,
      noBreak: false,
    });
  });

  it('disarms the retrospective while its card is hidden', () => {
    const hidden = { ...s, layout: patchCard(s.layout, 'retro', { visible: false }) };
    expect(armed(alarmTargets(tc(IN + 2 * HOUR_MS, IN), hidden, day, IN + 2 * HOUR_MS))).toEqual({
      lunchBy: true,
      lunchEnd: false,
      clockOut: true,
      secondMeal: false,
      retro: false,
      noBreak: true,
    });
  });

  it('disarms the retrospective once reviewed, and everything once the day is done', () => {
    expect(armed(alarmTargets(tc(IN + 2 * HOUR_MS, IN), s, { ...day, retroDone: true }, IN + 2 * HOUR_MS))).toEqual({
      lunchBy: true,
      lunchEnd: false,
      clockOut: true,
      secondMeal: false,
      retro: false,
      noBreak: true,
    });
    // Clocked out at 2 PM with no lunch: the missed lunch still reads overdue, but a done day rings nothing.
    const done = tc(IN + 6 * HOUR_MS + 5 * MINUTE_MS, IN, null, null, IN + 6 * HOUR_MS);
    expect([done.state, done.lunchStatus]).toEqual(['done', 'overdue']);
    expect(armed(alarmTargets(done, s, day, IN + 6 * HOUR_MS + 5 * MINUTE_MS))).toEqual({
      lunchBy: false,
      lunchEnd: false,
      clockOut: false,
      secondMeal: false,
      retro: false,
      noBreak: false,
    });
  });

  describe('the break alarm', () => {
    const noBreak = (now: number, d: TargetDay, ...at: (number | null)[]) => alarmTargets(tc(now, ...at), s, d, now).find((t) => t.id === 'noBreak')!;
    // Lunch 12:00 to 12:30.
    const lunch = [IN, IN + 4 * HOUR_MS, IN + 4.5 * HOUR_MS] as const;

    it('is due 90 min after the later of the last In reached and the end of the last break over', () => {
      const breaks = [makeBreak({ startedAt: IN + 3 * HOUR_MS, endedAt: IN + 3 * HOUR_MS + 10 * MINUTE_MS })];
      expect(noBreak(IN + 3.5 * HOUR_MS, { ...day, breaks }, IN)).toEqual({ id: 'noBreak', at: IN + 3 * HOUR_MS + 100 * MINUTE_MS, armed: true });
      // Lunch in came after that break.
      expect(noBreak(IN + 5 * HOUR_MS, { ...day, breaks }, ...lunch)).toEqual({ id: 'noBreak', at: IN + 6 * HOUR_MS, armed: true });
    });

    it('is disarmed on an extra Out, during a break or a session, and keeps its target through a session', () => {
      expect(noBreak(IN + 2 * HOUR_MS, day, IN, null, null, IN + HOUR_MS, null, null).armed).toBe(false);
      const running = [makeBreak({ startedAt: IN + HOUR_MS, endedAt: IN + HOUR_MS + 10 * MINUTE_MS })];
      expect(noBreak(IN + HOUR_MS + 5 * MINUTE_MS, { ...day, breaks: running }, IN)).toEqual({ id: 'noBreak', at: IN + 90 * MINUTE_MS, armed: false });
      const before = noBreak(IN + HOUR_MS, day, IN);
      const during = noBreak(IN + 2 * HOUR_MS, { ...day, timerRunning: true }, IN);
      const after = noBreak(IN + 2 * HOUR_MS, day, IN);
      expect([before, during, after]).toEqual([before, { ...before, armed: false }, before]);
    });

    it('holds from 30 min before an armed lunch deadline, and while lunch is overdue', () => {
      expect(noBreak(IN + 4.5 * HOUR_MS - MINUTE_MS, day, IN).armed).toBe(true);
      expect(noBreak(IN + 4.5 * HOUR_MS, day, IN).armed).toBe(false);
      expect(noBreak(IN + 5 * HOUR_MS + 10 * MINUTE_MS, day, IN).armed).toBe(false);
    });

    it('holds from 30 min before an armed clock-out until overtime is approved', () => {
      // The day ends at 4:30 PM.
      expect(noBreak(IN + 8 * HOUR_MS - MINUTE_MS, day, ...lunch).armed).toBe(true);
      expect(noBreak(IN + 8 * HOUR_MS + 10 * MINUTE_MS, day, ...lunch).armed).toBe(false);
      expect(noBreak(IN + 8 * HOUR_MS + 10 * MINUTE_MS, { ...day, overtimeApproved: true }, ...lunch).armed).toBe(true);
    });

    it('is not held by the second meal period', () => {
      // Overtime approved: the second meal is due at 6:30 PM, 10 min from now.
      const now = IN + 10 * HOUR_MS + 20 * MINUTE_MS;
      expect(armed(alarmTargets(tc(now, ...lunch), s, { ...day, overtimeApproved: true }, now))).toMatchObject({ secondMeal: true, noBreak: true });
    });

    it('rings when due and every hour after, until 30 min before lunch', () => {
      const on = { ...s, alarms: { ...s.alarms, noBreak: { ...s.alarms.noBreak, enabled: true } } };
      const fired = new Set<string>();
      const rang: AlarmEvent[] = [];
      for (let now = IN; now <= IN + 6 * HOUR_MS; now += MINUTE_MS) {
        const r = dueEvents(
          alarmTargets(computeTimeclock(punchesAt(IN), on, now), on, day, now).filter((t) => t.id === 'noBreak'),
          on.alarms,
          fired,
          now,
        );
        r.crossed.forEach((k) => fired.add(k));
        rang.push(...r.fire);
      }
      expect(rang.map((e) => [e.kind, e.minutes, e.at])).toEqual([
        ['due', 0, IN + 90 * MINUTE_MS],
        ['overdue', 60, IN + 150 * MINUTE_MS],
        ['overdue', 120, IN + 210 * MINUTE_MS],
      ]);
    });
  });
});

describe('missedClockIn', () => {
  const s = TEST_SETTINGS;
  // A break at 8:57:30 came before the session running since 9:02:40, and no punch is set.
  const first = T0 - 3 * MINUTE_MS;
  const logged = makeDay(TODAY, { sessions: [makeSession({ startedAt: T0 + 2 * MINUTE_MS + 40_000 })], breaks: [makeBreak({ startedAt: first + 30_000 })] });
  const alarmsOn = (...on: AlarmId[]) => ({
    lunchBy: { ...s.alarms.lunchBy, enabled: on.includes('lunchBy') },
    lunchEnd: { ...s.alarms.lunchEnd, enabled: on.includes('lunchEnd') },
    clockOut: { ...s.alarms.clockOut, enabled: on.includes('clockOut') },
    secondMeal: { ...s.alarms.secondMeal, enabled: on.includes('secondMeal') },
    retro: { ...s.alarms.retro, enabled: on.includes('retro') },
    noBreak: { ...s.alarms.noBreak, enabled: on.includes('noBreak') },
  });

  it('offers the earliest start of a session or break, floored to the minute', () => {
    expect(missedClockIn(logged, s)).toBe(first);
    expect(missedClockIn({ ...logged, breaks: [] }, s)).toBe(T0 + 2 * MINUTE_MS);
  });

  it('offers nothing with nothing logged or with any punch set, a Lunch out alone included', () => {
    expect(missedClockIn(makeDay(), s)).toBeNull();
    expect(missedClockIn({ ...logged, punches: punchesAt(null, T0) }, s)).toBeNull();
  });

  it('offers nothing with the Timeclock card hidden', () => {
    expect(missedClockIn(logged, { ...s, layout: patchCard(s.layout, 'timeclock', { visible: false }) })).toBeNull();
  });

  it('offers it while anything counts from the clock-in, each reason on its own, and nothing otherwise', () => {
    const only = (patch: Partial<Settings>) => missedClockIn(logged, { ...s, trackHours: false, alarms: alarmsOn(), ...patch });
    expect(only({})).toBeNull();
    expect(only({ trackHours: true })).toBe(first);
    expect(only({ alarms: alarmsOn('clockOut') })).toBe(first);
    // The meal alarms only with meal periods on, the retrospective's only with its card shown.
    for (const id of ['lunchBy', 'lunchEnd', 'secondMeal'] as const) {
      expect(only({ alarms: alarmsOn(id) })).toBe(first);
      expect(only({ alarms: alarmsOn(id), mealRules: false })).toBeNull();
    }
    expect(only({ alarms: alarmsOn('retro') })).toBe(first);
    expect(only({ alarms: alarmsOn('retro'), layout: patchCard(s.layout, 'retro', { visible: false }) })).toBeNull();
  });
});

describe('describeEvent', () => {
  // 8:32 clock-in, 8h day, lunch within 4h.
  const clockIn = new Date(2026, 8, 16, 8, 32).getTime();
  // Seen on time: half an hour ahead of the target, before any of these warnings is due.
  const ctx = {
    clockIn,
    hour12: true,
    workMinutes: 480,
    lunchDeadlineMinutes: 240,
    lunchMinutes: 30,
    secondMealAfterMinutes: 600,
    now: T - 30 * MINUTE_MS,
    typedClockOut: null,
  };
  const ev = (id: AlarmId, kind: AlarmEvent['kind'], minutes: number, target: number): AlarmEvent => ({
    key: eventKey(id, kind, minutes, target),
    id,
    kind,
    minutes,
    at: kind === 'lead' ? target - minutes * MINUTE_MS : target + minutes * MINUTE_MS,
    target,
  });

  it('names only the alarm in the kicker, whatever fired: the title says how long', () => {
    expect(describeEvent(ev('clockOut', 'lead', 15, T), ctx).kicker).toBe('Clock-out alarm');
    expect(describeEvent(ev('clockOut', 'due', 0, T), ctx).kicker).toBe('Clock-out alarm');
    expect(describeEvent(ev('clockOut', 'overdue', 10, T), ctx).kicker).toBe('Clock-out alarm');
    expect(describeEvent(ev('lunchBy', 'lead', 5, T), ctx).kicker).toBe('Lunch alarm');
    expect(describeEvent(ev('lunchBy', 'overdue', 65, T), ctx).kicker).toBe('Lunch alarm');
  });

  it('explains where the clock-out deadline came from', () => {
    const lead = describeEvent(ev('clockOut', 'lead', 15, T), ctx);
    expect(lead.title).toBe('Clock Out in 15 min');
    expect(lead.tone).toBe('warn');
    expect(lead.body).toContain('8h 00m day');
    expect(lead.body).toContain('clocked in');

    const due = describeEvent(ev('clockOut', 'due', 0, T), ctx);
    expect(due.title).toBe('Time to Clock Out');
    expect(due.tone).toBe('danger');
    expect(due.body).toBe(`You reached your 8h 00m for today at ${formatTime(T, true)}. Punch out now.`);

    const over = describeEvent(ev('clockOut', 'overdue', 10, T), ctx);
    expect(over.title).toBe('Clock-Out Is 10 min Overdue');
    expect(over.body).toContain('past your 8h 00m target');
  });

  it('names a Clock out typed ahead in the warning only while it is the target', () => {
    const typed = describeEvent(ev('clockOut', 'lead', 15, T), { ...ctx, typedClockOut: T });
    expect(typed).toEqual({
      kicker: 'Clock-out alarm',
      title: 'Clock Out in 15 min',
      body: `You set your Clock out for ${formatTime(T, true)}. Start wrapping up.`,
      tone: 'warn',
    });
    // A later typed time leaves the target on the planned end.
    expect(describeEvent(ev('clockOut', 'lead', 15, T), { ...ctx, typedClockOut: T + HOUR_MS }).body).toContain('8h 00m day');
  });

  it('frames the retrospective as a nudge before clock-out, never a deadline', () => {
    const lead = describeEvent(ev('retro', 'lead', 30, T), ctx);
    expect(lead.kicker).toBe('Retrospective');
    expect(lead.title).toBe('Look Back Before You Clock Out');
    // It comes before the clock-out warning, so it gives the end time itself.
    expect(lead.body).toBe(`Your day ends at ${formatTime(T, true)}. Compare what you planned with what you did while it's fresh.`);
    expect(lead.tone).toBe('warn');
    expect(describeEvent(ev('retro', 'due', 0, T), ctx).tone).toBe('warn');
    expect(describeEvent(ev('retro', 'overdue', 10, T), ctx).title).toBe('Retrospective Is 10 min Overdue');
  });

  it('explains the lunch deadline window', () => {
    const lead = describeEvent(ev('lunchBy', 'lead', 15, T), ctx);
    expect(lead.title).toBe('Lunch in 15 min');
    expect(lead.body).toBe(`Lunch must start by ${formatTime(T, true)}, 4h 00m after clocking in at ${formatTime(clockIn, true)}.`);
    const due = describeEvent(ev('lunchBy', 'due', 0, T), ctx);
    expect(due.title).toBe('Take Lunch Now');
    expect(due.body).toBe(`Your lunch deadline is ${formatTime(T, true)}. Punch Lunch out.`);
    const over = describeEvent(ev('lunchBy', 'overdue', 5, T), ctx);
    expect(over.title).toBe('Lunch Is 5 min Overdue');
    expect(over.body).toBe(`Your lunch deadline was ${formatTime(T, true)}. Punch Lunch out as soon as you can.`);
  });

  it('says lunch is over, where its end came from, and what is off while Lunch in is empty', () => {
    const lunch = `Lunch out at ${formatTime(T - 30 * MINUTE_MS, true)}; lunch is 30 min.`;
    const repeat = 'Clock-out and retrospective alarms are off until Lunch in is punched.';
    const copy = (kind: AlarmEvent['kind'], minutes: number) => describeEvent(ev('lunchEnd', kind, minutes, T), ctx);
    expect(copy('lead', 10)).toEqual({ kicker: 'Lunch end alarm', title: 'Lunch Ends in 10 min', body: lunch, tone: 'warn' });
    expect(copy('due', 0)).toEqual({ kicker: 'Lunch end alarm', title: 'Lunch Is Over', body: lunch, tone: 'warn' });
    expect(copy('overdue', 15)).toEqual({ kicker: 'Lunch end alarm', title: 'Lunch Ended 15 min Ago', body: repeat, tone: 'warn' });
    expect(copy('overdue', 60)).toEqual({ kicker: 'Lunch end alarm', title: 'Lunch Ended 1h 00m Ago', body: repeat, tone: 'warn' });
  });

  it('explains the second meal period rule', () => {
    const lead = describeEvent(ev('secondMeal', 'lead', 15, T), ctx);
    expect(lead.kicker).toBe('Second meal alarm');
    expect(lead.title).toBe('Second Meal Period in 15 min');
    expect(lead.body).toBe(`Your 10h 00m of work ends at ${formatTime(T, true)}. A second meal period is due before then.`);
    expect(describeEvent(ev('secondMeal', 'due', 0, T), ctx).title).toBe('Take Your Second Meal Period');
    const over = describeEvent(ev('secondMeal', 'overdue', 5, T), ctx);
    expect(over.title).toBe('Second Meal Period Is 5 min Overdue');
    expect(over.body).toBe(`Your 10h 00m of work ended at ${formatTime(T, true)}. Take your second meal period as soon as you can.`);
    expect(over.tone).toBe('danger');
  });

  it('says the time actually left when a warning is seen late', () => {
    // The phone was asleep through the 15-minute mark and wakes 8 min before clock-out.
    const late = describeEvent(ev('clockOut', 'lead', 15, T), { ...ctx, now: T - 8 * MINUTE_MS - 20_000 });
    expect(late.kicker).toBe('Clock-out alarm');
    expect(late.title).toBe('Clock Out in 9 min');
    expect(describeEvent(ev('lunchBy', 'lead', 15, T), { ...ctx, now: T - 3 * MINUTE_MS }).title).toBe('Lunch in 3 min');
    expect(describeEvent(ev('secondMeal', 'lead', 15, T), { ...ctx, now: T - 5 * MINUTE_MS }).title).toBe('Second Meal Period in 5 min');
    // Never "in 0 min" in the last seconds.
    expect(describeEvent(ev('clockOut', 'lead', 1, T), { ...ctx, now: T - 1000 }).title).toBe('Clock Out in 1 min');
  });

  it('gives the time a due alarm was for, which stays true when it is seen late', () => {
    // The app opened 40 min after the end of the day, with overdue repeats off: the due event is what fires.
    const late = { ...ctx, now: T + 40 * MINUTE_MS };
    expect(describeEvent(ev('clockOut', 'due', 0, T), late).body).toBe(`You reached your 8h 00m for today at ${formatTime(T, true)}. Punch out now.`);
    expect(describeEvent(ev('retro', 'due', 0, T), late).body).toBe(
      `You reached your 8h 00m at ${formatTime(T, true)}. Two minutes on what went to plan and what didn't.`,
    );
    expect(describeEvent(ev('secondMeal', 'due', 0, T), late).body).toBe(
      `You reached 10h 00m of work at ${formatTime(T, true)}. A second meal period was due by then.`,
    );
  });

  it('gives a warning seen after its deadline the due copy', () => {
    // The clock-in was typed in after the end of the day, or the phone slept through it, with the
    // due event and repeats off: the latest warning is what fires.
    const late = { ...ctx, now: T + 45 * MINUTE_MS };
    const clockOut = describeEvent(ev('clockOut', 'lead', 15, T), late);
    expect(clockOut.kicker).toBe('Clock-out alarm');
    expect(clockOut.title).toBe('Time to Clock Out');
    expect(clockOut.body).toBe(`You reached your 8h 00m for today at ${formatTime(T, true)}. Punch out now.`);
    const retro = describeEvent(ev('retro', 'lead', 30, T), late);
    expect(retro.kicker).toBe('Retrospective');
    expect(retro.title).toBe('Clocking Out? Do the Retrospective First.');
    expect(retro.body).toBe(`You reached your 8h 00m at ${formatTime(T, true)}. Two minutes on what went to plan and what didn't.`);
    expect(describeEvent(ev('lunchBy', 'lead', 5, T), { ...ctx, now: T }).title).toBe('Take Lunch Now');
  });

  it('says how long since the last rest for the break alarm, at every stage', () => {
    const since = formatTime(T - 90 * MINUTE_MS, true);
    expect(describeEvent(ev('noBreak', 'due', 0, T), { ...ctx, now: T })).toEqual({
      kicker: 'Break alarm',
      title: '1h 30m Without a Break',
      body: `Working since ${since}.`,
      tone: 'warn',
    });
    expect(since).toMatch(/AM$/);
    const repeat = describeEvent(ev('noBreak', 'overdue', 60, T), { ...ctx, now: T + 60 * MINUTE_MS + 20_000 });
    expect([repeat.title, repeat.tone]).toEqual(['2h 30m Without a Break', 'warn']);
    // Raised 35 min late, once a timer that ran past the target was finished.
    expect(describeEvent(ev('noBreak', 'due', 0, T), { ...ctx, now: T + 35 * MINUTE_MS }).title).toBe('2h 05m Without a Break');
    // A warning only a hand-made PUT can set.
    expect(describeEvent(ev('noBreak', 'lead', 10, T), { ...ctx, now: T - 10 * MINUTE_MS })).toMatchObject({ title: '1h 20m Without a Break', tone: 'warn' });
  });

  it('writes a non-round work day as the Worked tile does', () => {
    expect(describeEvent(ev('clockOut', 'lead', 5, T), { ...ctx, workMinutes: 425 }).body).toContain('7h 05m day');
  });
});
