import { describe, expect, it } from 'vitest';
import { alarmTargets, describeEvent, dueEvents, eventKey, type AlarmEvent, type AlarmTarget } from './alarms';
import { formatTime } from './format';
import { computeTimeclock, emptyPunches } from './timeclock';
import type { AlarmId, AlarmSettings } from '../types';

const M = 60_000;
const T = new Date(2026, 8, 16, 13, 0).getTime();
const D = '2026-09-16';
const cfg = (over: Partial<AlarmSettings> = {}): AlarmSettings => ({
  enabled: true,
  leadMinutes: [15, 5, 1],
  onDue: true,
  overdueEveryMinutes: 5,
  ...over,
});
const alarms = (lunch = cfg(), clock = cfg(), meal = cfg(), retro = cfg({ leadMinutes: [30], onDue: false, overdueEveryMinutes: 0 })) => ({
  lunchBy: lunch,
  clockOut: clock,
  secondMeal: meal,
  retro,
});
const target = (at: number, id: AlarmId = 'clockOut', armed = true): AlarmTarget => ({ id, at, armed });

describe('dueEvents', () => {
  it('fires nothing before the first lead', () => {
    const r = dueEvents(D, [target(T)], alarms(), new Set(), T - 20 * M);
    expect(r.fire).toEqual([]);
    expect(r.crossed).toEqual([]);
  });

  it('fires a lead exactly when crossed and reports it as crossed', () => {
    const r = dueEvents(D, [target(T)], alarms(), new Set(), T - 15 * M);
    expect(r.fire.map((e) => [e.kind, e.minutes])).toEqual([['lead', 15]]);
    expect(r.crossed).toEqual([eventKey(D, 'clockOut', 'lead', 15, T)]);
  });

  it('does not re-fire an event already recorded as fired', () => {
    const fired = new Set([eventKey(D, 'clockOut', 'lead', 15, T)]);
    const r = dueEvents(D, [target(T)], alarms(), fired, T - 14 * M);
    expect(r.fire).toEqual([]);
  });

  it('fires the due event at the target', () => {
    const fired = new Set([15, 5, 1].map((m) => eventKey(D, 'clockOut', 'lead', m, T)));
    const r = dueEvents(D, [target(T)], alarms(), fired, T);
    expect(r.fire.map((e) => e.kind)).toEqual(['due']);
  });

  it('repeats while overdue at the configured interval', () => {
    const fired = new Set([...[15, 5, 1].map((m) => eventKey(D, 'clockOut', 'lead', m, T)), eventKey(D, 'clockOut', 'due', 0, T)]);
    expect(dueEvents(D, [target(T)], alarms(), fired, T + 4 * M).fire).toEqual([]);
    const r = dueEvents(D, [target(T)], alarms(), fired, T + 5 * M);
    expect(r.fire.map((e) => [e.kind, e.minutes])).toEqual([['overdue', 5]]);
    fired.add(r.crossed[0]!);
    const r2 = dueEvents(D, [target(T)], alarms(), fired, T + 10 * M);
    expect(r2.fire.map((e) => [e.kind, e.minutes])).toEqual([['overdue', 10]]);
  });

  it('collapses a catch-up burst to the latest event but marks all as crossed', () => {
    // Phone slept from T-20m to T+7m: leads 15/5/1, due and overdue 5 all crossed.
    const r = dueEvents(D, [target(T)], alarms(), new Set(), T + 7 * M);
    expect(r.fire.map((e) => [e.kind, e.minutes])).toEqual([['overdue', 5]]);
    expect(r.crossed).toHaveLength(5);
  });

  it('re-arms when the target moves later', () => {
    const fired = new Set<string>();
    const first = dueEvents(D, [target(T)], alarms(), fired, T - 15 * M);
    first.crossed.forEach((k) => fired.add(k));
    // Lunch ran long; clock-out is now 20 minutes later. The 15-minute lead is 5 minutes away again.
    const moved = T + 20 * M;
    expect(dueEvents(D, [target(moved)], alarms(), fired, T - 14 * M).fire).toEqual([]);
    const again = dueEvents(D, [target(moved)], alarms(), fired, moved - 15 * M);
    expect(again.fire.map((e) => [e.kind, e.minutes])).toEqual([['lead', 15]]);
  });

  it('ignores disarmed targets and disabled alarms', () => {
    expect(dueEvents(D, [target(T, 'clockOut', false)], alarms(), new Set(), T).fire).toEqual([]);
    expect(dueEvents(D, [target(T)], alarms(cfg(), cfg({ enabled: false })), new Set(), T).fire).toEqual([]);
  });

  it('honours onDue=false and overdueEveryMinutes=0', () => {
    const a = alarms(cfg(), cfg({ leadMinutes: [], onDue: false, overdueEveryMinutes: 0 }));
    expect(dueEvents(D, [target(T)], a, new Set(), T + 60 * M).fire).toEqual([]);
  });

  it('handles each target independently', () => {
    const r = dueEvents(D, [target(T, 'lunchBy'), target(T + 3 * 60 * M, 'clockOut'), target(T + 15 * M, 'secondMeal')], alarms(), new Set(), T);
    expect(r.fire.map((e) => [e.id, e.kind])).toEqual([
      ['lunchBy', 'due'],
      ['secondMeal', 'lead'],
    ]);
  });
});

describe('alarmTargets', () => {
  // 8:00 clock-in, an 8 h day, lunch by 1 PM, a second meal after 10 h.
  const s = { workMinutes: 480, lunchDeadlineMinutes: 300, lunchMinutes: 30, secondMealAfterMinutes: 600 };
  const H = 60 * M;
  const IN = new Date(2026, 8, 16, 8, 0).getTime();
  const day = { overtimeApproved: false, retroDone: false };
  // Punches in row order (in, lunch out, lunch in, out), at `now`.
  const tc = (now: number, ...at: (number | null)[]) =>
    computeTimeclock(
      emptyPunches().map((p, i) => ({ ...p, at: at[i] ?? null })),
      s,
      now,
    );
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
    const now = tc(IN + 2 * H, IN);
    const targets = alarmTargets(now, s, day);
    expect(targets.map((t) => t.at)).toEqual([IN + 5 * H, now.clockOutAt, now.secondMealBy, now.clockOutAt]);
    // An 8 h day never reaches the 10 h second meal.
    expect(armed(targets)).toEqual({ lunchBy: true, clockOut: true, secondMeal: false, retro: true });
    expect(armed(alarmTargets(tc(IN + 5 * H + 10 * M, IN), s, day)).lunchBy).toBe(true);
  });

  it('disarms clock-out and the retrospective at lunch, where the end of the day drifts, and lunch once taken', () => {
    expect(armed(alarmTargets(tc(IN + 4 * H + 10 * M, IN, IN + 4 * H), s, day))).toEqual({ lunchBy: false, clockOut: false, secondMeal: false, retro: false });
    const back = tc(IN + 5 * H, IN, IN + 4 * H, IN + 4 * H + 30 * M);
    expect(armed(alarmTargets(back, s, day))).toEqual({ lunchBy: false, clockOut: true, secondMeal: false, retro: true });
  });

  it('with overtime approved, silences only clock-out, and the second meal comes due', () => {
    expect(armed(alarmTargets(tc(IN + 2 * H, IN), s, { ...day, overtimeApproved: true }))).toEqual({
      lunchBy: true,
      clockOut: false,
      secondMeal: true,
      retro: true,
    });
  });

  it('waits for punches out of order to be fixed before the end of the day or the second meal ring', () => {
    // Clock out typed before Lunch out: the timeclock reads "working" while the day is over.
    const tangled = tc(IN + 9 * H, IN, IN + 8 * H + 25 * M, null, IN + 8 * H + 20 * M);
    expect([tangled.error, tangled.state]).toEqual([expect.any(String), 'working']);
    expect(armed(alarmTargets(tangled, s, { ...day, overtimeApproved: true }))).toEqual({ lunchBy: false, clockOut: false, secondMeal: false, retro: false });
  });

  it('keeps lunch armed with the punches out of order, since its deadline comes from the clock-in', () => {
    // Mid-morning, no lunch yet, and a Clock out typed as 2:00 AM: the typo must not mute the meal period.
    const typo = tc(IN + 3 * H, IN, null, null, IN - 6 * H);
    expect([typo.error, typo.state, typo.lunchStatus]).toEqual([expect.any(String), 'working', 'upcoming']);
    expect(armed(alarmTargets(typo, s, day))).toEqual({ lunchBy: true, clockOut: false, secondMeal: false, retro: false });
  });

  it('disarms the retrospective once reviewed, and everything once the day is done', () => {
    expect(armed(alarmTargets(tc(IN + 2 * H, IN), s, { ...day, retroDone: true }))).toEqual({ lunchBy: true, clockOut: true, secondMeal: false, retro: false });
    // Clocked out at 2 PM with no lunch: the missed lunch still reads overdue, but a done day rings nothing.
    const done = tc(IN + 6 * H + 5 * M, IN, null, null, IN + 6 * H);
    expect([done.state, done.lunchStatus]).toEqual(['done', 'overdue']);
    expect(armed(alarmTargets(done, s, day))).toEqual({ lunchBy: false, clockOut: false, secondMeal: false, retro: false });
  });
});

describe('describeEvent', () => {
  // 8:32 clock-in, 8h day, lunch within 4h.
  const clockIn = new Date(2026, 8, 16, 8, 32).getTime();
  // Seen on time: half an hour ahead of the target, before any of these warnings is due.
  const ctx = { clockIn, hour12: true, workMinutes: 480, lunchDeadlineMinutes: 240, secondMealAfterMinutes: 600, now: T - 30 * M };
  const ev = (id: AlarmId, kind: AlarmEvent['kind'], minutes: number, target: number): AlarmEvent => ({
    key: eventKey(D, id, kind, minutes, target),
    id,
    kind,
    minutes,
    at: kind === 'lead' ? target - minutes * M : target + minutes * M,
    target,
  });

  it('names the alarm and the rule that fired in the kicker', () => {
    expect(describeEvent(ev('clockOut', 'lead', 15, T), ctx).kicker).toBe('Clock-out alarm · 15 min warning');
    expect(describeEvent(ev('clockOut', 'due', 0, T), ctx).kicker).toBe("Clock-out alarm · time's up");
    expect(describeEvent(ev('clockOut', 'overdue', 10, T), ctx).kicker).toBe('Clock-out alarm · 10 min overdue');
    expect(describeEvent(ev('lunchBy', 'lead', 5, T), ctx).kicker).toBe('Lunch alarm · 5 min warning');
    expect(describeEvent(ev('lunchBy', 'overdue', 65, T), ctx).kicker).toBe('Lunch alarm · 1h 5m overdue');
  });

  it('explains where the clock-out deadline came from', () => {
    const lead = describeEvent(ev('clockOut', 'lead', 15, T), ctx);
    expect(lead.title).toBe('Clock out in 15 min');
    expect(lead.tone).toBe('warn');
    expect(lead.body).toContain('8h day');
    expect(lead.body).toContain('clocked in');

    const due = describeEvent(ev('clockOut', 'due', 0, T), ctx);
    expect(due.title).toBe('Time to clock out');
    expect(due.tone).toBe('danger');
    expect(due.body).toBe(`You reached your 8h for today at ${formatTime(T, true)}. Punch out now.`);

    const over = describeEvent(ev('clockOut', 'overdue', 10, T), ctx);
    expect(over.title).toBe('Clock out is 10 min overdue');
    expect(over.body).toContain('past your 8h target');
  });

  it('frames the retrospective as a nudge before clock-out, never a deadline', () => {
    const lead = describeEvent(ev('retro', 'lead', 30, T), ctx);
    expect(lead.kicker).toBe('Retrospective · 30 min before clock-out');
    expect(lead.title).toBe('Look back before you clock out');
    expect(lead.body).toContain('1:00');
    expect(lead.tone).toBe('warn');
    expect(describeEvent(ev('retro', 'due', 0, T), ctx).tone).toBe('warn');
    expect(describeEvent(ev('retro', 'overdue', 10, T), ctx).title).toBe('Retrospective is 10 min overdue');
  });

  it('explains the lunch deadline window', () => {
    const lead = describeEvent(ev('lunchBy', 'lead', 15, T), ctx);
    expect(lead.title).toBe('Lunch in 15 min');
    expect(lead.body).toBe(`Lunch must start by ${formatTime(T, true)}, 4h after clocking in at ${formatTime(clockIn, true)}.`);
    expect(describeEvent(ev('lunchBy', 'due', 0, T), ctx).title).toBe('Take lunch now');
    expect(describeEvent(ev('lunchBy', 'overdue', 5, T), ctx).title).toBe('Lunch is 5 min overdue');
  });

  it('explains the second meal period rule', () => {
    const lead = describeEvent(ev('secondMeal', 'lead', 15, T), ctx);
    expect(lead.kicker).toBe('Second meal alarm · 15 min warning');
    expect(lead.title).toBe('Second meal break in 15 min');
    expect(lead.body).toContain('10h of work ends at');
    expect(lead.body).toContain('California');
    expect(describeEvent(ev('secondMeal', 'due', 0, T), ctx).title).toBe('Take your second meal break');
    const over = describeEvent(ev('secondMeal', 'overdue', 5, T), ctx);
    expect(over.title).toBe('Second meal break is 5 min overdue');
    expect(over.tone).toBe('danger');
  });

  it('says the time actually left when a warning is seen late, and keeps the rule in the kicker', () => {
    // The phone was asleep through the 15-minute mark and wakes 8 min before clock-out.
    const late = describeEvent(ev('clockOut', 'lead', 15, T), { ...ctx, now: T - 8 * M - 20_000 });
    expect(late.kicker).toBe('Clock-out alarm · 15 min warning');
    expect(late.title).toBe('Clock out in 9 min');
    expect(describeEvent(ev('lunchBy', 'lead', 15, T), { ...ctx, now: T - 3 * M }).title).toBe('Lunch in 3 min');
    expect(describeEvent(ev('secondMeal', 'lead', 15, T), { ...ctx, now: T - 5 * M }).title).toBe('Second meal break in 5 min');
    // Never "in 0 min" in the last seconds.
    expect(describeEvent(ev('clockOut', 'lead', 1, T), { ...ctx, now: T - 1000 }).title).toBe('Clock out in 1 min');
  });

  it('gives the time a due alarm was for, which stays true when it is seen late', () => {
    // The app opened 40 min after the end of the day, with overdue repeats off: the due event is what fires.
    const late = { ...ctx, now: T + 40 * M };
    expect(describeEvent(ev('clockOut', 'due', 0, T), late).body).toBe(`You reached your 8h for today at ${formatTime(T, true)}. Punch out now.`);
    expect(describeEvent(ev('retro', 'due', 0, T), late).body).toBe(
      `You reached your 8h at ${formatTime(T, true)}. Two minutes on what went to plan and what didn't.`,
    );
    expect(describeEvent(ev('secondMeal', 'due', 0, T), late).body).toBe(
      `You reached 10h of work at ${formatTime(T, true)}. California requires a second 30-minute meal period by then unless you've waived it.`,
    );
  });

  it('formats a non-round work day', () => {
    expect(describeEvent(ev('clockOut', 'lead', 5, T), { ...ctx, workMinutes: 450 }).body).toContain('7h 30m day');
  });
});
