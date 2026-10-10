// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { alert } from '../lib/alerts';
import { MINUTE_MS } from '../../../shared/dates.js';
import { answered, deferred, makeDay, makeSettings, punchesAt, settle, SettingsAndDays, T0, TODAY } from '../test/hooks';
import type { Day, Settings } from '../types';
import { useDayStore } from './useDay';
import { useTodayAlarms } from './useTodayAlarms';

vi.mock('../api');
vi.mock('../lib/alerts');

// Clocked in 8 h 35 m ago with a 30 min lunch: 5 min past an 8 h day.
const overDay = (patch: Partial<Day> = {}) =>
  makeDay(TODAY, { punches: punchesAt(T0 - 515 * MINUTE_MS, T0 - 300 * MINUTE_MS, T0 - 270 * MINUTE_MS), ...patch });

/** Lets the loads land, then waits out the three seconds the punches take to settle. */
async function judged(): Promise<void> {
  await settle();
  await settle(5_000);
}

const alerted = () => vi.mocked(alert).mock.calls.map(([a]) => a);
const tags = () => alerted().map((a) => a.tag);

function render(settings: Settings | Promise<Settings>, day: Day) {
  vi.mocked(api.getSettings).mockReturnValue(Promise.resolve(settings).then(answered));
  vi.mocked(api.getDay).mockResolvedValue(answered(day));
  return renderHook(() => ({ alarms: useTodayAlarms(TODAY, Date.now(), vi.fn()), store: useDayStore() }), { wrapper: SettingsAndDays });
}

/** Another device, from scratch: the alarms already fired here are remembered in storage. */
function freshDevice() {
  cleanup();
  localStorage.clear();
  vi.mocked(alert).mockClear();
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  localStorage.clear();
});

describe('useTodayAlarms', () => {
  it('waits for the settings, and judges the day by them rather than the defaults', async () => {
    const settings = deferred<Settings>();
    render(settings.promise, overDay());
    // The day and its punches are in: 8 h 5 m worked, so an 8 h 20 m day has 15 min left, where
    // the defaults' 8 h would ring overdue now.
    await judged();
    expect(alert).not.toHaveBeenCalled();
    settings.resolve(makeSettings({ workMinutes: 500 }));
    await judged();
    expect(alerted().find((a) => a.tag === 'alarm:clockOut')?.title).toBe('Clock out in 15 min');
  });

  it("goes by today's own work-day length", async () => {
    // A half day, clocked in 4 h 10 m ago: over by 10 min, where the usual 8 h is hours away.
    render(makeSettings(), makeDay(TODAY, { punches: punchesAt(T0 - 250 * MINUTE_MS), workMinutes: 240 }));
    await judged();
    expect(alerted().find((a) => a.tag === 'alarm:clockOut')?.title).toBe('Clock out is 10 min overdue');
  });

  it('keeps an approved day quiet only while Overtime is on, and offers the button only then', async () => {
    render(makeSettings(), overDay({ overtimeApproved: true }));
    await judged();
    expect(tags()).toEqual(['alarm:retro']);

    freshDevice();
    render(makeSettings({ overtimeApproval: false }), overDay({ overtimeApproved: true }));
    await judged();
    const clockOut = alerted().find((a) => a.tag === 'alarm:clockOut');
    expect(clockOut).toBeDefined();
    expect(clockOut!.action).toBeUndefined();

    freshDevice();
    render(makeSettings(), overDay());
    await judged();
    const action = alerted().find((a) => a.tag === 'alarm:clockOut')!.action!;
    expect(action.label).toBe('Overtime approved');
    // The button approves today, where the switch on the card would.
    vi.mocked(api.putOvertime).mockResolvedValue(answered({ overtimeApproved: true }));
    await act(async () => action.run());
    expect(api.putOvertime).toHaveBeenCalledWith(TODAY, true);
  });

  it('holds while a punch is being typed, and judges the punches three seconds after', async () => {
    vi.mocked(api.putPunches).mockImplementation((_date, punches) => Promise.resolve(answered({ punches })));
    const { result } = render(makeSettings(), makeDay());
    await judged();
    act(() => result.current.alarms.setEditingPunches(true));
    await act(() => result.current.store.setPunches(TODAY, overDay().punches));
    await judged();
    expect(alert).not.toHaveBeenCalled();
    act(() => result.current.alarms.setEditingPunches(false));
    await settle(2_900);
    expect(alert).not.toHaveBeenCalled();
    await settle(200);
    expect(tags()).toContain('alarm:clockOut');
  });

  it('lets a hold go five minutes after the last change, though focus stays and a refresh brings the same times in a new list', async () => {
    vi.mocked(api.putPunches).mockImplementation((_date, punches) => Promise.resolve(answered({ punches })));
    const { result } = render(makeSettings(), makeDay());
    await judged();
    act(() => result.current.alarms.setEditingPunches(true));
    // The server has the edit, and a note written on another device makes the next refresh a new
    // list with the same times.
    vi.mocked(api.getDay).mockResolvedValue(answered(overDay({ retroNote: 'From the phone' })));
    await act(() => result.current.store.setPunches(TODAY, overDay().punches));
    await settle(5 * MINUTE_MS - 1000);
    expect(vi.mocked(api.getDay).mock.calls.length).toBeGreaterThan(1);
    expect(tags()).not.toContain('alarm:clockOut');
    await settle(1000);
    expect(tags()).toContain('alarm:clockOut');
  });

  it('keeps judging while a field has focus and nothing was typed, though a refresh brings the same times in a new list', async () => {
    // Clocked in 8 h 29 m ago with a 30 min lunch: the day ends a minute from now.
    const day = makeDay(TODAY, { punches: punchesAt(T0 - 509 * MINUTE_MS, T0 - 300 * MINUTE_MS, T0 - 270 * MINUTE_MS) });
    const { result } = render(makeSettings(), day);
    await judged();
    act(() => result.current.alarms.setEditingPunches(true));
    vi.mocked(api.getDay).mockResolvedValue(answered({ ...day, retroNote: 'From the phone' }));
    vi.mocked(alert).mockClear();
    // The minute's refresh lands as the day ends, with a note from another device: the same times
    // in a new list.
    await settle(MINUTE_MS);
    expect(api.getDay).toHaveBeenCalledTimes(2);
    expect(alerted().find((a) => a.tag === 'alarm:clockOut')?.title).toBe('Time to clock out');
  });
});
