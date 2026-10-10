import { describe, expect, it } from 'vitest';
import { HOUR_MS, MINUTE_MS } from '../../../shared/dates.js';
import { punchesAt, TEST_SETTINGS } from '../test/fixtures';
import { alarmTargets, describeEvent, dueEvents, eventKey, type AlarmEvent, type AlarmTarget } from './alarms';
import { formatTime } from './format';
import { patchCard } from './layout';
import { computeTimeclock } from './timeclock';
import type { AlarmId, AlarmSettings } from '../types';

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
});

describe('alarmTargets', () => {
  // 8:00 clock-in, an 8 h day, lunch by 1 PM, a second meal after 10 h, every card shown.
  const s = TEST_SETTINGS;
  const IN = new Date(2026, 8, 16, 8, 0).getTime();
  const day = { overtimeApproved: false, retroDone: false };
  const tc = (now: number, ...at: (number | null)[]) => computeTimeclock(punchesAt(...at), s, now);
  const armed = (targets: AlarmTarget[]) => Object.fromEntries(targets.map((t) => [t.id, t.armed]));

  it('has nothing armed before clock-in', () => {
    const targets = alarmTargets(tc(IN), s, day);
    expect(targets).toEqual([
      { id: 'lunchBy', at: 0, armed: false },
      { id: 'clockOut', at: 0, armed: false },
      { id: 'secondMeal', at: 0, armed: false },
      { id: 'retro', at: 0, armed: false },
    ]);
  });

  it('arms lunch, clock-out and the retrospective while working before lunch, and lunch while it is overdue', () => {
    const now = tc(IN + 2 * HOUR_MS, IN);
    const targets = alarmTargets(now, s, day);
    expect(targets.map((t) => t.at)).toEqual([IN + 5 * HOUR_MS, now.clockOutAt, now.secondMealBy, now.clockOutAt]);
    // An 8 h day never reaches the 10 h second meal.
    expect(armed(targets)).toEqual({ lunchBy: true, clockOut: true, secondMeal: false, retro: true });
    expect(armed(alarmTargets(tc(IN + 5 * HOUR_MS + 10 * MINUTE_MS, IN), s, day)).lunchBy).toBe(true);
  });

  it('rings the clock-out warnings before the end of a day whose lunch was never taken', () => {
    const fired = new Set<string>();
    const rang: AlarmEvent[] = [];
    for (let now = IN + 4 * HOUR_MS; now <= IN + 8 * HOUR_MS; now += MINUTE_MS) {
      // The lunch alarm repeats all afternoon.
      const r = dueEvents(
        alarmTargets(tc(now, IN), s, day).filter((t) => t.id !== 'lunchBy'),
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
    expect(armed(alarmTargets(short, half, day))).toEqual({ lunchBy: false, clockOut: true, secondMeal: true, retro: true });
  });

  it('disarms clock-out and the retrospective at lunch, where the end of the day drifts, and lunch once taken', () => {
    expect(armed(alarmTargets(tc(IN + 4 * HOUR_MS + 10 * MINUTE_MS, IN, IN + 4 * HOUR_MS), s, day))).toEqual({
      lunchBy: false,
      clockOut: false,
      secondMeal: false,
      retro: false,
    });
    const back = tc(IN + 5 * HOUR_MS, IN, IN + 4 * HOUR_MS, IN + 4 * HOUR_MS + 30 * MINUTE_MS);
    expect(armed(alarmTargets(back, s, day))).toEqual({ lunchBy: false, clockOut: true, secondMeal: false, retro: true });
  });

  it('with overtime approved, silences only clock-out, and the second meal comes due', () => {
    expect(armed(alarmTargets(tc(IN + 2 * HOUR_MS, IN), s, { ...day, overtimeApproved: true }))).toEqual({
      lunchBy: true,
      clockOut: false,
      secondMeal: true,
      retro: true,
    });
  });

  it('waits for punches out of order to be fixed before the end of the day or the second meal ring', () => {
    // Clock out typed before Lunch out: the timeclock reads "working" while the day is over.
    const tangled = tc(IN + 9 * HOUR_MS, IN, IN + 8 * HOUR_MS + 25 * MINUTE_MS, null, IN + 8 * HOUR_MS + 20 * MINUTE_MS);
    expect([tangled.outOfOrder, tangled.state]).toEqual([{ position: 3, after: 1 }, 'working']);
    expect(armed(alarmTargets(tangled, s, { ...day, overtimeApproved: true }))).toEqual({ lunchBy: false, clockOut: false, secondMeal: false, retro: false });
  });

  it('keeps lunch armed with the punches out of order, since its deadline comes from the clock-in', () => {
    // Mid-morning, no lunch yet, and a Clock out typed as 2:00 AM: the typo must not mute the meal period.
    const typo = tc(IN + 3 * HOUR_MS, IN, null, null, IN - 6 * HOUR_MS);
    expect([typo.outOfOrder, typo.state, typo.lunchStatus]).toEqual([{ position: 3, after: 0 }, 'working', 'upcoming']);
    expect(armed(alarmTargets(typo, s, day))).toEqual({ lunchBy: true, clockOut: false, secondMeal: false, retro: false });
  });

  it('disarms the retrospective while its card is hidden', () => {
    const hidden = { ...s, layout: patchCard(s.layout, 'retro', { visible: false }) };
    expect(armed(alarmTargets(tc(IN + 2 * HOUR_MS, IN), hidden, day))).toEqual({ lunchBy: true, clockOut: true, secondMeal: false, retro: false });
  });

  it('disarms the retrospective once reviewed, and everything once the day is done', () => {
    expect(armed(alarmTargets(tc(IN + 2 * HOUR_MS, IN), s, { ...day, retroDone: true }))).toEqual({
      lunchBy: true,
      clockOut: true,
      secondMeal: false,
      retro: false,
    });
    // Clocked out at 2 PM with no lunch: the missed lunch still reads overdue, but a done day rings nothing.
    const done = tc(IN + 6 * HOUR_MS + 5 * MINUTE_MS, IN, null, null, IN + 6 * HOUR_MS);
    expect([done.state, done.lunchStatus]).toEqual(['done', 'overdue']);
    expect(armed(alarmTargets(done, s, day))).toEqual({ lunchBy: false, clockOut: false, secondMeal: false, retro: false });
  });
});

describe('describeEvent', () => {
  // 8:32 clock-in, 8h day, lunch within 4h.
  const clockIn = new Date(2026, 8, 16, 8, 32).getTime();
  // Seen on time: half an hour ahead of the target, before any of these warnings is due.
  const ctx = { clockIn, hour12: true, workMinutes: 480, lunchDeadlineMinutes: 240, secondMealAfterMinutes: 600, now: T - 30 * MINUTE_MS };
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
    expect(lead.body).toContain('8h day');
    expect(lead.body).toContain('clocked in');

    const due = describeEvent(ev('clockOut', 'due', 0, T), ctx);
    expect(due.title).toBe('Time to Clock Out');
    expect(due.tone).toBe('danger');
    expect(due.body).toBe(`You reached your 8h for today at ${formatTime(T, true)}. Punch out now.`);

    const over = describeEvent(ev('clockOut', 'overdue', 10, T), ctx);
    expect(over.title).toBe('Clock-Out Is 10 min Overdue');
    expect(over.body).toContain('past your 8h target');
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
    expect(lead.body).toBe(`Lunch must start by ${formatTime(T, true)}, 4h after clocking in at ${formatTime(clockIn, true)}.`);
    const due = describeEvent(ev('lunchBy', 'due', 0, T), ctx);
    expect(due.title).toBe('Take Lunch Now');
    expect(due.body).toBe(`Your lunch deadline is ${formatTime(T, true)}. Punch Lunch out.`);
    const over = describeEvent(ev('lunchBy', 'overdue', 5, T), ctx);
    expect(over.title).toBe('Lunch Is 5 min Overdue');
    expect(over.body).toBe(`Your lunch deadline was ${formatTime(T, true)}. Punch Lunch out as soon as you can.`);
  });

  it('explains the second meal period rule', () => {
    const lead = describeEvent(ev('secondMeal', 'lead', 15, T), ctx);
    expect(lead.kicker).toBe('Second meal alarm');
    expect(lead.title).toBe('Second Meal Period in 15 min');
    expect(lead.body).toBe(`Your 10h of work ends at ${formatTime(T, true)}. A second meal period is due before then.`);
    expect(describeEvent(ev('secondMeal', 'due', 0, T), ctx).title).toBe('Take Your Second Meal Period');
    const over = describeEvent(ev('secondMeal', 'overdue', 5, T), ctx);
    expect(over.title).toBe('Second Meal Period Is 5 min Overdue');
    expect(over.body).toBe(`Your 10h of work ended at ${formatTime(T, true)}. Take your second meal period as soon as you can.`);
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
    expect(describeEvent(ev('clockOut', 'due', 0, T), late).body).toBe(`You reached your 8h for today at ${formatTime(T, true)}. Punch out now.`);
    expect(describeEvent(ev('retro', 'due', 0, T), late).body).toBe(
      `You reached your 8h at ${formatTime(T, true)}. Two minutes on what went to plan and what didn't.`,
    );
    expect(describeEvent(ev('secondMeal', 'due', 0, T), late).body).toBe(
      `You reached 10h of work at ${formatTime(T, true)}. A second meal period was due by then.`,
    );
  });

  it('gives a warning seen after its deadline the due copy', () => {
    // The clock-in was typed in after the end of the day, or the phone slept through it, with the
    // due event and repeats off: the latest warning is what fires.
    const late = { ...ctx, now: T + 45 * MINUTE_MS };
    const clockOut = describeEvent(ev('clockOut', 'lead', 15, T), late);
    expect(clockOut.kicker).toBe('Clock-out alarm');
    expect(clockOut.title).toBe('Time to Clock Out');
    expect(clockOut.body).toBe(`You reached your 8h for today at ${formatTime(T, true)}. Punch out now.`);
    const retro = describeEvent(ev('retro', 'lead', 30, T), late);
    expect(retro.kicker).toBe('Retrospective');
    expect(retro.title).toBe('Clocking Out? Do the Retrospective First.');
    expect(retro.body).toBe(`You reached your 8h at ${formatTime(T, true)}. Two minutes on what went to plan and what didn't.`);
    expect(describeEvent(ev('lunchBy', 'lead', 5, T), { ...ctx, now: T }).title).toBe('Take Lunch Now');
  });

  it('formats a non-round work day', () => {
    expect(describeEvent(ev('clockOut', 'lead', 5, T), { ...ctx, workMinutes: 450 }).body).toContain('7h 30m day');
  });
});
