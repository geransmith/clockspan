import { describe, expect, it } from 'vitest';
import { dueEvents, eventKey, type AlarmTarget } from './alarms';
import type { AlarmSettings } from '../types';

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
const alarms = (lunch = cfg(), clock = cfg()) => ({ lunchBy: lunch, clockOut: clock });
const target = (at: number, id: 'lunchBy' | 'clockOut' = 'clockOut', armed = true): AlarmTarget => ({ id, at, armed });

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
    const fired = new Set([
      ...[15, 5, 1].map((m) => eventKey(D, 'clockOut', 'lead', m, T)),
      eventKey(D, 'clockOut', 'due', 0, T),
    ]);
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

  it('handles both targets independently', () => {
    const r = dueEvents(D, [target(T, 'lunchBy'), target(T + 3 * 60 * M, 'clockOut')], alarms(), new Set(), T);
    expect(r.fire.map((e) => [e.id, e.kind])).toEqual([['lunchBy', 'due']]);
  });
});
