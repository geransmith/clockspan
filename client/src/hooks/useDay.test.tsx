// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { dismissByTag, warnQuietly } from '../lib/alerts';
import { ADD_PRIORITY_FAILED, SAVE_FAILED } from '../lib/copy';
import { MINUTE_MS } from '../../../shared/dates.js';
import { MAX_PRIORITIES } from '../../../shared/settings.js';
import {
  apiError,
  begin,
  deferred,
  endSession,
  makeBreak,
  makeDay,
  makePriority,
  makeSession,
  makeSettings,
  MIDNIGHT,
  punchesAt,
  settle,
  SettingsAndDays,
  setVisibility,
  T0,
  TODAY,
  YESTERDAY,
} from '../test/hooks';
import type { BreakEndResponse, BreakResponse, Day, OkResponse, OvertimeResponse, Priority, PruneResult, Punch, PunchesResponse, Session } from '../types';
import { useDay, useDays, useDayStore, useRefreshDay } from './useDay';

vi.mock('../api');
vi.mock('../lib/alerts');

const OTHER = '2026-09-25';

/** The store's functions and state, plus `useDay(date)` so the day loads the way the sheet loads it. */
function renderStore(date: string | null = TODAY) {
  return renderHook(
    () => {
      const store = { ...useDayStore(), ...useDays() };
      if (date) useDay(date);
      return store;
    },
    { wrapper: SettingsAndDays },
  );
}

/** The server's answer to a list PUT: the list as sent, which is what it stores. */
const echoPunches = (_date: string, punches: Punch[]) => Promise.resolve({ punches });
const echoPriorities = (_date: string, priorities: Priority[]) => Promise.resolve({ priorities });

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('load', () => {
  it('fetches a day on first use and normalizes its punches', async () => {
    // An old day that ended in an unset out/in pair: the pair's out becomes the clock out.
    const legacy = [...punchesAt(T0).slice(0, 3), { position: 3, kind: 'out' as const, at: null }, { position: 4, kind: 'in' as const, at: null }];
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { punches: legacy }));
    const { result } = renderStore();
    await settle();
    expect(api.getDay).toHaveBeenCalledTimes(1);
    expect(result.current.days[TODAY]?.punches.map((p) => p.position)).toEqual([0, 1, 2, 3]);
  });

  it('shares one request between callers asking at once', async () => {
    const answer = deferred<Day>();
    vi.mocked(api.getDay).mockReturnValue(answer.promise);
    const { result } = renderStore(null);
    const a = result.current.load(TODAY);
    const b = result.current.load(TODAY);
    answer.resolve(makeDay());
    await act(() => Promise.all([a, b]));
    expect(api.getDay).toHaveBeenCalledTimes(1);
  });

  it('treats an answer that is not a day as a failed load, and the next load asks again', async () => {
    // request() refuses a body that isn't JSON (a proxy's sign-in page), but JSON that isn't a
    // day still reaches here: the throw while landing it counts as a failed load.
    vi.mocked(api.getDay).mockResolvedValueOnce(null as unknown as Day);
    const { result } = renderStore();
    await settle();
    expect(result.current.failed.has(TODAY)).toBe(true);
    expect(warnQuietly).toHaveBeenCalledWith(expect.objectContaining({ tag: 'load-failed' }));

    vi.mocked(api.getDay).mockResolvedValueOnce(makeDay());
    await act(() => result.current.load(TODAY));
    expect(api.getDay).toHaveBeenCalledTimes(2);
    expect(result.current.failed.size).toBe(0);
    expect(result.current.days[TODAY]).toBeDefined();
  });

  it("takes down the load-failed banner when the day that raised it loads, not another day's", async () => {
    vi.mocked(api.getDay).mockResolvedValueOnce(makeDay()).mockRejectedValueOnce(new Error('offline'));
    const { result } = renderStore();
    await settle();
    await act(() => result.current.load(OTHER));
    expect(warnQuietly).toHaveBeenCalledWith(expect.objectContaining({ tag: 'load-failed' }));
    // Today's minute refresh: the other day still failed, so its banner stays.
    vi.mocked(api.getDay).mockResolvedValueOnce(makeDay());
    await act(() => result.current.refresh(TODAY));
    expect(dismissByTag).not.toHaveBeenCalled();

    vi.mocked(api.getDay).mockResolvedValueOnce(makeDay(OTHER));
    await act(() => result.current.load(OTHER));
    expect(dismissByTag).toHaveBeenCalledWith('load-failed');
  });

  it('records a failed first load, raises the banner, and waits for Try again', async () => {
    vi.mocked(api.getDay).mockRejectedValueOnce(new Error('Request failed (502)'));
    const { result } = renderStore();
    await settle();
    expect(result.current.failed.has(TODAY)).toBe(true);
    expect(result.current.days[TODAY]).toBeUndefined();
    expect(warnQuietly).toHaveBeenCalledWith(expect.objectContaining({ tag: 'load-failed' }));
    // useDay does not ask again on its own: the failure is on screen with a Try again button.
    await settle(5 * MINUTE_MS);
    expect(api.getDay).toHaveBeenCalledTimes(1);

    vi.mocked(api.getDay).mockResolvedValueOnce(makeDay());
    await act(() => result.current.load(TODAY));
    expect(result.current.failed.size).toBe(0);
    expect(result.current.days[TODAY]).toBeDefined();
  });

  it('keeps showing a loaded day when a reload fails, without a banner', async () => {
    vi.mocked(api.getDay).mockResolvedValueOnce(makeDay(TODAY, { retroNote: 'kept' }));
    const { result } = renderStore();
    await settle();
    vi.mocked(api.getDay).mockRejectedValueOnce(new Error('offline'));
    await act(() => result.current.load(TODAY));
    expect(result.current.days[TODAY]?.retroNote).toBe('kept');
    expect(result.current.failed.size).toBe(0);
    expect(warnQuietly).not.toHaveBeenCalled();
  });
});

describe('a day shown again', () => {
  const renderDay = () => renderHook((p: { date: string }) => useDay(p.date), { initialProps: { date: TODAY }, wrapper: SettingsAndDays });

  it('is read again, and the answer shows', async () => {
    vi.mocked(api.getDay)
      .mockResolvedValueOnce(makeDay())
      .mockResolvedValueOnce(makeDay(OTHER))
      .mockResolvedValueOnce(makeDay(TODAY, { retroNote: 'from the phone' }));
    const { result, rerender } = renderDay();
    await settle();
    rerender({ date: OTHER });
    await settle();
    rerender({ date: TODAY });
    expect(result.current.day?.retroNote).toBe('');
    await settle();
    expect(result.current.day?.retroNote).toBe('from the phone');
    // Once per showing: the answer landing sends nothing more.
    expect(api.getDay).toHaveBeenCalledTimes(3);
  });

  it('is asked for again quietly when its first load failed', async () => {
    vi.mocked(api.getDay)
      .mockRejectedValueOnce(new Error('Request failed (502)'))
      .mockResolvedValueOnce(makeDay(OTHER))
      .mockRejectedValueOnce(new Error('Request failed (504)'));
    const { result, rerender } = renderDay();
    await settle();
    rerender({ date: OTHER });
    await settle();
    rerender({ date: TODAY });
    await settle();
    expect(api.getDay).toHaveBeenCalledTimes(3);
    expect(result.current.failed).toBe(true);
    expect(warnQuietly).toHaveBeenCalledTimes(1);
  });
});

describe('load after a write', () => {
  it('keeps what was written when a load sent before the write answers after it', async () => {
    vi.mocked(api.getDay).mockResolvedValueOnce(makeDay());
    const { result } = renderStore();
    await settle();
    // A background read asks for the day again, and a punch goes out before it answers.
    const stale = deferred<Day>();
    vi.mocked(api.getDay)
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(makeDay(TODAY, { punches: punchesAt(T0) }));
    vi.mocked(api.putPunches).mockImplementation(echoPunches);
    const loaded = begin(() => result.current.refresh(TODAY));
    await act(() => result.current.setPunches(TODAY, punchesAt(T0)));
    stale.resolve(makeDay());
    await act(() => loaded);
    expect(result.current.days[TODAY]?.punches[0]?.at).toBe(T0);
    // Its answer was dropped and may miss another device's change, so the day is asked for again.
    await settle();
    expect(api.getDay).toHaveBeenCalledTimes(3);
    expect(result.current.days[TODAY]?.punches[0]?.at).toBe(T0);
  });

  it('still fills in a day whose first load was out when a write to it was saved, and asks for the day again', async () => {
    // Today's first load is out when a break started from the bar is saved.
    const first = deferred<Day>();
    const again = deferred<Day>();
    vi.mocked(api.getDay).mockReturnValueOnce(first.promise).mockReturnValueOnce(again.promise);
    const saved = makeBreak({ id: 3 });
    vi.mocked(api.startBreak).mockResolvedValue({ break: saved });
    const { result } = renderStore();
    await act(() => result.current.startBreak(TODAY, 300));
    expect(result.current.days[TODAY]).toBeUndefined();
    // Read before the break was saved, but the best copy there is: it shows, and the day is asked for again.
    first.resolve(makeDay(TODAY, { punches: punchesAt(T0) }));
    await settle();
    expect(result.current.days[TODAY]?.punches[0]?.at).toBe(T0);
    expect(api.getDay).toHaveBeenCalledTimes(2);
    again.resolve(makeDay(TODAY, { punches: punchesAt(T0), breaks: [saved] }));
    await settle();
    expect(result.current.days[TODAY]?.breaks).toEqual([saved]);
  });

  it('does not make up a day for a session confirmed before its first load, and asks for the day again', async () => {
    // Today's first load is out when the timer's auto-finish comes back.
    const first = deferred<Day>();
    const done = endSession(makeSession({ id: 5 }), { endedAt: T0 + 25 * MINUTE_MS, durationSeconds: 1500 });
    vi.mocked(api.getDay)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(makeDay(TODAY, { punches: punchesAt(T0), sessions: [done] }));
    const { result } = renderStore();
    act(() => result.current.applySession(done));
    expect(result.current.days[TODAY]).toBeUndefined();
    // The first answer was read before the finish: it has the punches but not the session.
    first.resolve(makeDay(TODAY, { punches: punchesAt(T0) }));
    await settle();
    expect(api.getDay).toHaveBeenCalledTimes(2);
    expect(result.current.days[TODAY]?.punches[0]?.at).toBe(T0);
    expect(result.current.days[TODAY]?.sessions.map((x) => x.id)).toEqual([5]);
  });

  it('keeps a punch waiting to go out when a load sent while it waited answers first', async () => {
    vi.mocked(api.getDay).mockResolvedValueOnce(makeDay());
    const { result } = renderStore();
    await settle();
    const first = deferred<PunchesResponse>();
    vi.mocked(api.putPunches).mockReturnValueOnce(first.promise).mockImplementation(echoPunches);
    const stale = deferred<Day>();
    vi.mocked(api.getDay).mockReturnValueOnce(stale.promise);
    // Clock in goes out, lunch out waits behind it, and then a background read asks for the day.
    let saved!: Promise<boolean>;
    act(() => {
      void result.current.setPunches(TODAY, punchesAt(T0));
      saved = result.current.setPunches(TODAY, punchesAt(T0, T0 + 240 * MINUTE_MS));
    });
    const loaded = begin(() => result.current.refresh(TODAY));
    // The server has only the clock-in so far.
    stale.resolve(makeDay(TODAY, { punches: punchesAt(T0) }));
    await act(() => loaded);
    expect(result.current.days[TODAY]?.punches[1]?.at).toBe(T0 + 240 * MINUTE_MS);
    first.resolve({ punches: vi.mocked(api.putPunches).mock.calls[0]![1] });
    await act(() => saved);
    expect(vi.mocked(api.putPunches).mock.calls.map(([, p]) => p[1]?.at)).toEqual([null, T0 + 240 * MINUTE_MS]);
    expect(result.current.days[TODAY]?.punches[1]?.at).toBe(T0 + 240 * MINUTE_MS);
  });

  it('puts the stored copy back at once after a failed save, and the reload shares a load already out', async () => {
    vi.mocked(api.getDay).mockResolvedValueOnce(makeDay());
    const { result } = renderStore();
    await settle();
    const out = deferred<Day>();
    vi.mocked(api.getDay).mockReturnValueOnce(out.promise);
    vi.mocked(api.putOvertime).mockRejectedValueOnce(new Error('offline'));
    const loaded = begin(() => result.current.load(TODAY));
    await act(() => result.current.setOvertimeApproved(TODAY, true));
    // No answer from anywhere yet, and the sheet already shows what the server has.
    expect(result.current.days[TODAY]?.overtimeApproved).toBe(false);
    // A refused save changed nothing on the server, so the load already out answers for it.
    expect(api.getDay).toHaveBeenCalledTimes(2);
    out.resolve(makeDay(TODAY, { retroNote: 'stored' }));
    await act(() => loaded);
    expect(result.current.days[TODAY]).toMatchObject({ overtimeApproved: false, retroNote: 'stored' });
  });

  it('asks again after a failed save when the load it shared comes back stale', async () => {
    const stored = makeBreak({ id: 1, startedAt: T0 - 30 * MINUTE_MS, endedAt: T0 - 25 * MINUTE_MS });
    vi.mocked(api.getDay).mockResolvedValueOnce(makeDay(TODAY, { breaks: [stored] }));
    const { result } = renderStore();
    await settle();
    // A background read is out when overtime saves and the break's delete doesn't reach the server.
    const out = deferred<Day>();
    vi.mocked(api.getDay)
      .mockReturnValueOnce(out.promise)
      .mockResolvedValueOnce(makeDay(TODAY, { overtimeApproved: true, retroNote: 'from the phone', breaks: [stored] }));
    vi.mocked(api.putOvertime).mockResolvedValueOnce({ overtimeApproved: true });
    vi.mocked(api.deleteBreak).mockRejectedValueOnce(new Error('offline'));
    const refreshed = begin(() => result.current.refresh(TODAY));
    await act(() => result.current.setOvertimeApproved(TODAY, true));
    await act(() => result.current.removeBreak(TODAY, 1));
    expect(result.current.days[TODAY]?.breaks).toEqual([stored]);
    expect(warnQuietly).toHaveBeenCalledWith(expect.objectContaining({ tag: 'save-failed' }));
    expect(api.getDay).toHaveBeenCalledTimes(2);
    // Read before the overtime save, so it is dropped: the store asks again.
    out.resolve(makeDay(TODAY, { breaks: [stored] }));
    await act(() => refreshed);
    await settle();
    expect(api.getDay).toHaveBeenCalledTimes(3);
    expect(result.current.days[TODAY]).toMatchObject({ overtimeApproved: true, retroNote: 'from the phone', breaks: [stored] });
  });

  it('shows the stored copy, not the change, when the server is down for the save and the reload alike', async () => {
    vi.mocked(api.getDay).mockResolvedValueOnce(makeDay()).mockRejectedValue(new Error('offline'));
    vi.mocked(api.putPunches).mockRejectedValue(new Error('offline'));
    const { result } = renderStore();
    await settle();
    await act(() => result.current.setPunches(TODAY, punchesAt(T0)));
    await settle();
    expect(api.getDay).toHaveBeenCalledTimes(2);
    expect(result.current.days[TODAY]?.punches[0]?.at).toBeNull();
    expect(result.current.failed.size).toBe(0);
    expect(vi.mocked(warnQuietly).mock.calls.map(([w]) => w.tag)).toEqual(['save-failed']);
  });

  it("keeps another list's change on top when a failed save's reload answers first", async () => {
    vi.mocked(api.getDay)
      .mockResolvedValueOnce(makeDay())
      .mockResolvedValueOnce(makeDay(TODAY, { retroNote: 'reloaded' }));
    vi.mocked(api.putPunches).mockRejectedValueOnce(new Error('offline'));
    const rows = deferred<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(rows.promise);
    const { result } = renderStore();
    await settle();
    const listed = begin(() => result.current.setPriorities(TODAY, [makePriority(1, 'Still here')]));
    await act(() => result.current.setPunches(TODAY, punchesAt(T0)));
    await settle();
    // The reload has the server's copy, from before the priorities PUT: the row is still shown over it.
    expect(result.current.days[TODAY]).toMatchObject({ retroNote: 'reloaded', priorities: [{ text: 'Still here' }] });
    rows.resolve({ priorities: [makePriority(1, 'Still here')] });
    expect(await act(() => listed)).toBe(true);
    expect(result.current.days[TODAY]?.priorities.map((p) => p.text)).toEqual(['Still here']);
  });
});

describe('refresh', () => {
  it("adopts the server's copy of a loaded day", async () => {
    vi.mocked(api.getDay)
      .mockResolvedValueOnce(makeDay())
      .mockResolvedValueOnce(makeDay(TODAY, { retroNote: 'from the phone' }));
    const { result } = renderStore();
    await settle();
    await act(() => result.current.refresh(TODAY));
    expect(result.current.days[TODAY]?.retroNote).toBe('from the phone');
  });

  it('keeps a day a refresh brings back unchanged', async () => {
    vi.mocked(api.getDay).mockImplementation(() => Promise.resolve(makeDay(TODAY, { punches: punchesAt(T0) })));
    const { result } = renderStore();
    await settle();
    const before = result.current.days[TODAY];
    await act(() => result.current.refresh(TODAY));
    expect(api.getDay).toHaveBeenCalledTimes(2);
    expect(result.current.days[TODAY]).toBe(before);
  });

  it('sends nothing for a day not loaded yet, and a change still out stays on top of the answer', async () => {
    const first = deferred<Day>();
    vi.mocked(api.getDay).mockReturnValueOnce(first.promise);
    const { result } = renderStore();
    await result.current.refresh(OTHER);
    await result.current.refresh(TODAY);
    expect(api.getDay).toHaveBeenCalledTimes(1);
    first.resolve(makeDay());
    await settle();

    // Another device wrote a note; this one is saving overtime meanwhile. Both show.
    const save = deferred<OvertimeResponse>();
    vi.mocked(api.putOvertime).mockReturnValueOnce(save.promise);
    vi.mocked(api.getDay).mockResolvedValueOnce(makeDay(TODAY, { retroNote: 'from the phone' }));
    act(() => void result.current.setOvertimeApproved(TODAY, true));
    await act(() => result.current.refresh(TODAY));
    expect(api.getDay).toHaveBeenCalledTimes(2);
    expect(result.current.days[TODAY]).toMatchObject({ overtimeApproved: true, retroNote: 'from the phone' });
    save.resolve({ overtimeApproved: true });
    await settle();
    expect(result.current.days[TODAY]).toMatchObject({ overtimeApproved: true, retroNote: 'from the phone' });
  });
});

describe('refresh after a failed first load', () => {
  it('asks again quietly: no second banner while the server is down, the day once it answers', async () => {
    vi.mocked(api.getDay).mockRejectedValueOnce(new Error('Request failed (502)'));
    const { result } = renderStore();
    await settle();
    expect(warnQuietly).toHaveBeenCalledTimes(1);

    vi.mocked(api.getDay).mockRejectedValueOnce(new Error('Request failed (504)'));
    await act(() => result.current.refresh(TODAY));
    expect(api.getDay).toHaveBeenCalledTimes(2);
    expect(result.current.failed.has(TODAY)).toBe(true);
    expect(warnQuietly).toHaveBeenCalledTimes(1);

    vi.mocked(api.getDay).mockResolvedValueOnce(makeDay(TODAY, { retroNote: 'back' }));
    await act(() => result.current.refresh(TODAY));
    expect(result.current.failed.size).toBe(0);
    expect(result.current.days[TODAY]?.retroNote).toBe('back');
    expect(dismissByTag).toHaveBeenCalledWith('load-failed');
  });
});

describe('setPunches', () => {
  it('shows the punches at once and sends one PUT at a time, skipping to the newest', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay());
    const first = deferred<PunchesResponse>();
    vi.mocked(api.putPunches).mockReturnValueOnce(first.promise).mockImplementation(echoPunches);
    const { result } = renderStore();
    await settle();
    const done = begin(() => result.current.setPunches(TODAY, punchesAt(T0)));
    expect(result.current.days[TODAY]?.punches[0]?.at).toBe(T0);
    // Two more edits while the first PUT is out: only the last one is sent after it.
    act(() => void result.current.setPunches(TODAY, punchesAt(T0 + MINUTE_MS)));
    act(() => void result.current.setPunches(TODAY, punchesAt(T0 + 2 * MINUTE_MS)));
    expect(api.putPunches).toHaveBeenCalledTimes(1);
    first.resolve({ punches: vi.mocked(api.putPunches).mock.calls[0]![1] });
    await act(() => done);
    expect(vi.mocked(api.putPunches).mock.calls.map(([, p]) => p[0]?.at)).toEqual([T0, T0 + 2 * MINUTE_MS]);
    expect(result.current.days[TODAY]?.punches[0]?.at).toBe(T0 + 2 * MINUTE_MS);
  });

  it('drops the list waiting behind a failed save and shows the reloaded day', async () => {
    vi.mocked(api.getDay)
      .mockResolvedValueOnce(makeDay())
      .mockResolvedValueOnce(makeDay(TODAY, { punches: punchesAt(T0 - MINUTE_MS) }));
    const first = deferred<PunchesResponse>();
    vi.mocked(api.putPunches).mockReturnValueOnce(first.promise);
    const { result } = renderStore();
    await settle();
    const done = begin(() => result.current.setPunches(TODAY, punchesAt(T0)));
    act(() => void result.current.setPunches(TODAY, punchesAt(T0 + MINUTE_MS)));
    first.reject(new Error('offline'));
    await act(() => done);
    await settle();
    expect(api.putPunches).toHaveBeenCalledTimes(1);
    expect(warnQuietly).toHaveBeenCalledWith(expect.objectContaining({ title: SAVE_FAILED.title, tag: 'save-failed' }));
    expect(result.current.days[TODAY]?.punches[0]?.at).toBe(T0 - MINUTE_MS);
  });

  it('sends the list for a day never loaded, and leaves that day to load from the server', async () => {
    vi.mocked(api.putPunches).mockImplementation(echoPunches);
    const { result } = renderStore(null);
    await act(() => result.current.setPunches(OTHER, punchesAt(T0)));
    expect(vi.mocked(api.putPunches).mock.calls[0]?.[1][0]?.at).toBe(T0);
    expect(result.current.days[OTHER]).toBeUndefined();
  });
});

describe('priorities', () => {
  it('setPriorities says whether the list was saved', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay());
    vi.mocked(api.putPriorities).mockImplementationOnce(echoPriorities).mockRejectedValueOnce(new Error('offline'));
    const { result } = renderStore();
    await settle();
    await act(async () => expect(await result.current.setPriorities(TODAY, [makePriority(1, 'Ship it')])).toBe(true));
    expect(result.current.days[TODAY]?.priorities[0]?.text).toBe('Ship it');
    await act(async () => expect(await result.current.setPriorities(TODAY, [makePriority(1, 'Lost')])).toBe(false));
  });

  it('sends one list at a time, skipping to the newest, and tells every caller it was saved', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay());
    const first = deferred<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(first.promise).mockImplementation(echoPriorities);
    const { result } = renderStore();
    await settle();
    const saves: Promise<boolean>[] = [];
    act(() => void saves.push(result.current.setPriorities(TODAY, [makePriority(1, 'One', { done: true })])));
    act(() => void saves.push(result.current.setPriorities(TODAY, [makePriority(1, 'One', { done: true }), makePriority(2, 'Two')])));
    act(() => void saves.push(result.current.setPriorities(TODAY, [makePriority(1, 'One', { done: true }), makePriority(2, 'Two', { done: true })])));
    expect(api.putPriorities).toHaveBeenCalledTimes(1);
    first.resolve({ priorities: vi.mocked(api.putPriorities).mock.calls[0]![1] });
    await act(async () => expect(await Promise.all(saves)).toEqual([true, true, true]));
    expect(api.putPriorities).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.putPriorities).mock.calls[1]?.[1].map((p) => p.done)).toEqual([true, true]);
  });

  it('addPriority fills the first empty row and resolves to its uid', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { priorities: [makePriority(1, 'First')] }));
    vi.mocked(api.putPriorities).mockImplementation(echoPriorities);
    const { result } = renderStore();
    await settle();
    let uid = '';
    await act(async () => {
      uid = await result.current.addPriority(TODAY, 'From the timer');
    });
    const rows = result.current.days[TODAY]!.priorities;
    expect(rows.map((p) => p.text)).toEqual(['First', 'From the timer', '']);
    expect(rows[1]).toMatchObject({ uid, addedAt: T0 });
  });

  it('addPriority rejects when the list is full, the day is not loaded, or the save fails', async () => {
    const full = Array.from({ length: MAX_PRIORITIES }, (_, i) => makePriority(i + 1, `Row ${i + 1}`));
    // Every later GET is the other day's: its load, then the reload after the failed save.
    vi.mocked(api.getDay)
      .mockResolvedValue(makeDay(OTHER))
      .mockResolvedValueOnce(makeDay(TODAY, { priorities: full }));
    vi.mocked(api.putPriorities).mockRejectedValue(new Error('offline'));
    const { result } = renderStore();
    await settle();
    await expect(result.current.addPriority(TODAY, 'One more')).rejects.toThrow(ADD_PRIORITY_FAILED.full);
    // A day not loaded has no list to add to: one made up empty would replace the stored rows.
    // Nothing was sent, so the reason given is the load, not a failed save.
    await expect(result.current.addPriority(OTHER, 'Unsaved')).rejects.toThrow(ADD_PRIORITY_FAILED.notLoaded);
    expect(api.putPriorities).not.toHaveBeenCalled();
    await act(() => result.current.load(OTHER));
    await expect(act(() => result.current.addPriority(OTHER, 'Unsaved'))).rejects.toThrow(SAVE_FAILED.title);
    expect(api.putPriorities).toHaveBeenCalledTimes(1);
  });

  it('prioritiesSaved resolves at once with no priorities save out', async () => {
    const { result } = renderStore(null);
    await expect(result.current.prioritiesSaved(TODAY)).resolves.toBeUndefined();
    expect(api.putPriorities).not.toHaveBeenCalled();
  });

  it('prioritiesSaved waits for the save out and the list waiting behind it', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay());
    const first = deferred<{ priorities: Priority[] }>();
    const second = deferred<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderStore();
    await settle();
    let saved = false;
    act(() => {
      void result.current.setPriorities(TODAY, [makePriority(1, 'One')]);
      void result.current.setPriorities(TODAY, [makePriority(1, 'One'), makePriority(2, 'Two')]);
      void result.current.prioritiesSaved(TODAY).then(() => (saved = true));
    });
    first.resolve({ priorities: [makePriority(1, 'One')] });
    await settle();
    expect(api.putPriorities).toHaveBeenCalledTimes(2);
    expect(saved).toBe(false);
    second.resolve({ priorities: [makePriority(1, 'One'), makePriority(2, 'Two')] });
    await settle();
    expect(saved).toBe(true);
  });

  it('prioritiesSaved resolves, without rejecting, when the save is refused', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay());
    const refused = deferred<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(refused.promise);
    const { result } = renderStore();
    await settle();
    let saved!: Promise<void>;
    act(() => {
      void result.current.setPriorities(TODAY, [makePriority(1, 'Lost')]);
      saved = result.current.prioritiesSaved(TODAY);
    });
    refused.reject(new Error('offline'));
    await act(() => expect(saved).resolves.toBeUndefined());
  });
});

describe('per-day fields', () => {
  it('setOvertimeApproved says whether the server saved it', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay());
    vi.mocked(api.putOvertime).mockResolvedValueOnce({ overtimeApproved: true }).mockRejectedValueOnce(new Error('offline'));
    const { result } = renderStore();
    await settle();
    await act(async () => expect(await result.current.setOvertimeApproved(TODAY, true)).toBe(true));
    expect(result.current.days[TODAY]?.overtimeApproved).toBe(true);
    await act(async () => expect(await result.current.setOvertimeApproved(TODAY, false)).toBe(false));
  });

  it('setRetro keeps the note and stamp it was not asked to change, then takes the stored stamp', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { retroNote: 'why', retroAt: null }));
    const saved = deferred<{ retroNote: string; retroAt: number | null }>();
    vi.mocked(api.putRetro).mockReturnValueOnce(saved.promise);
    const { result } = renderStore();
    await settle();

    const done = begin(() => result.current.setRetro(TODAY, { done: true }));
    expect(result.current.days[TODAY]).toMatchObject({ retroNote: 'why', retroAt: T0 });
    saved.resolve({ retroNote: 'why', retroAt: T0 - 5 });
    await act(() => done);
    expect(result.current.days[TODAY]?.retroAt).toBe(T0 - 5);

    vi.mocked(api.putRetro).mockResolvedValueOnce({ retroNote: 'why', retroAt: T0 - 5 });
    act(() => void result.current.setRetro(TODAY, { done: true }));
    expect(result.current.days[TODAY]?.retroAt).toBe(T0 - 5); // already reviewed: the first stamp stays
    await settle();

    vi.mocked(api.putRetro).mockResolvedValueOnce({ retroNote: 'because', retroAt: T0 - 5 });
    act(() => void result.current.setRetro(TODAY, { note: 'because' }));
    expect(result.current.days[TODAY]).toMatchObject({ retroNote: 'because', retroAt: T0 - 5 });
    await settle();

    vi.mocked(api.putRetro).mockResolvedValueOnce({ retroNote: 'because', retroAt: null });
    act(() => void result.current.setRetro(TODAY, { done: false }));
    expect(result.current.days[TODAY]?.retroAt).toBeNull();
    await settle();
  });

  it('setWorkMinutes is optimistic, and a failed save puts the stored length back', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay());
    vi.mocked(api.putTarget).mockResolvedValueOnce({ workMinutes: 240 });
    const { result } = renderStore();
    await settle();
    act(() => void result.current.setWorkMinutes(TODAY, 240));
    expect(result.current.days[TODAY]?.workMinutes).toBe(240);
    await settle();
    expect(api.putTarget).toHaveBeenCalledWith(TODAY, 240);

    const reload = deferred<Day>();
    vi.mocked(api.getDay).mockReturnValueOnce(reload.promise);
    vi.mocked(api.putTarget).mockRejectedValueOnce(new Error('offline'));
    const done = begin(() => result.current.setWorkMinutes(TODAY, 300));
    expect(result.current.days[TODAY]?.workMinutes).toBe(300);
    await act(() => done);
    // The reload is still out: the sheet shows the length the server stored.
    expect(result.current.days[TODAY]?.workMinutes).toBe(240);
    expect(api.getDay).toHaveBeenCalledTimes(2);
    reload.resolve(makeDay(TODAY, { workMinutes: 240 }));
    await settle();
    expect(result.current.days[TODAY]?.workMinutes).toBe(240);
  });

  it("sends a day's field changes one after another, in the order they were made", async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay());
    const on = deferred<OvertimeResponse>();
    vi.mocked(api.putOvertime).mockReturnValueOnce(on.promise).mockResolvedValueOnce({ overtimeApproved: false });
    vi.mocked(api.putTarget).mockResolvedValueOnce({ workMinutes: 240 });
    const { result } = renderStore();
    await settle();
    act(() => void result.current.setOvertimeApproved(TODAY, true));
    act(() => void result.current.setOvertimeApproved(TODAY, false));
    const done = begin(() => result.current.setWorkMinutes(TODAY, 240));
    await settle();
    expect(api.putOvertime).toHaveBeenCalledTimes(1);
    expect(api.putTarget).not.toHaveBeenCalled();
    on.resolve({ overtimeApproved: true });
    await act(() => done);
    expect(vi.mocked(api.putOvertime).mock.calls.map(([, v]) => v)).toEqual([true, false]);
    expect(api.putTarget).toHaveBeenCalledWith(TODAY, 240);
    expect(result.current.days[TODAY]).toMatchObject({ overtimeApproved: false, workMinutes: 240 });
  });
});

describe('sessions', () => {
  it('applySession inserts, replaces and drops a cancelled row, in start order', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay());
    const { result } = renderStore();
    await settle();
    const later = makeSession({ id: 2, startedAt: T0 + 30 * MINUTE_MS });
    const earlier = makeSession({ id: 1, startedAt: T0 });
    act(() => result.current.applySession(later));
    act(() => result.current.applySession(earlier));
    expect(result.current.days[TODAY]?.sessions.map((s) => s.id)).toEqual([1, 2]);
    act(() => result.current.applySession({ ...later, label: 'Renamed' }));
    expect(result.current.days[TODAY]?.sessions[1]?.label).toBe('Renamed');
    act(() => result.current.applySession(endSession(earlier, { status: 'cancelled' })));
    expect(result.current.days[TODAY]?.sessions.map((s) => s.id)).toEqual([2]);
  });

  it('removeSession drops the row before the server answers', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { sessions: [makeSession()] }));
    const answer = deferred<OkResponse>();
    vi.mocked(api.deleteSession).mockReturnValue(answer.promise);
    const { result } = renderStore();
    await settle();
    const done = begin(() => result.current.removeSession(TODAY, 1));
    expect(result.current.days[TODAY]?.sessions).toEqual([]);
    answer.resolve({ ok: true });
    await act(() => done);
    expect(result.current.days[TODAY]?.sessions).toEqual([]);
    expect(api.deleteSession).toHaveBeenCalledWith(1);
  });

  it('removeSession counts a 404 as done: another device deleted the row already', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { sessions: [makeSession()] }));
    vi.mocked(api.deleteSession).mockRejectedValue(apiError(404));
    const { result } = renderStore();
    await settle();
    await act(() => result.current.removeSession(TODAY, 1));
    await settle();
    expect(result.current.days[TODAY]?.sessions).toEqual([]);
    expect(warnQuietly).not.toHaveBeenCalled();
    expect(api.getDay).toHaveBeenCalledTimes(1);
  });

  it('updateSession shows the edit at once, then keeps the stored row', async () => {
    const other = makeSession({ id: 2, label: 'Other', startedAt: T0 + 30 * MINUTE_MS });
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { sessions: [makeSession(), other] }));
    const answer = deferred<{ session: Session }>();
    vi.mocked(api.patchSession).mockReturnValueOnce(answer.promise);
    const { result } = renderStore();
    await settle();
    const done = begin(() => result.current.updateSession(TODAY, 1, { label: 'Renamed' }));
    expect(result.current.days[TODAY]?.sessions.map((x) => x.label)).toEqual(['Renamed', 'Other']);
    answer.resolve({ session: makeSession({ label: 'Renamed (stored)' }) });
    await act(() => done);
    expect(result.current.days[TODAY]?.sessions[0]?.label).toBe('Renamed (stored)');
  });

  it('updateSession links a row to a priority only once that priorities save has answered', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { sessions: [makeSession()] }));
    const typed = makePriority(1, 'Just typed');
    const rows = deferred<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(rows.promise);
    vi.mocked(api.patchSession).mockResolvedValueOnce({ session: makeSession({ priorityUid: typed.uid }) });
    const { result } = renderStore();
    await settle();
    let done!: Promise<boolean>;
    act(() => {
      void result.current.setPriorities(TODAY, [typed]);
      done = result.current.updateSession(TODAY, 1, { priorityUid: typed.uid });
    });
    expect(result.current.days[TODAY]?.sessions[0]?.priorityUid).toBe(typed.uid);
    await settle();
    // The server refuses a uid it hasn't stored.
    expect(api.patchSession).not.toHaveBeenCalled();
    rows.resolve({ priorities: [typed] });
    expect(await act(() => done)).toBe(true);
    expect(api.patchSession).toHaveBeenCalledWith(1, { priorityUid: typed.uid });
  });
});

describe('breaks', () => {
  const over = makeBreak({ id: 1, startedAt: T0 - 30 * MINUTE_MS, endedAt: T0 - 25 * MINUTE_MS });
  const running = makeBreak({ id: 2, startedAt: T0 - 2 * MINUTE_MS, endedAt: T0 + 3 * MINUTE_MS });

  it('startBreak shows the break once the server has it, and ends one still running as the server does', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { breaks: [over, running] }));
    const answer = deferred<BreakResponse>();
    vi.mocked(api.startBreak).mockReturnValue(answer.promise);
    const { result } = renderStore();
    await settle();
    const done = begin(() => result.current.startBreak(TODAY, 600));
    await settle();
    expect(api.startBreak).toHaveBeenCalledWith(TODAY, 600);
    expect(result.current.days[TODAY]?.breaks).toEqual([over, running]);
    const saved = makeBreak({ id: 3, plannedSeconds: 600, startedAt: T0, endedAt: T0 + 10 * MINUTE_MS });
    answer.resolve({ break: saved });
    await act(() => done);
    expect(result.current.days[TODAY]?.breaks).toEqual([over, { ...running, endedAt: T0 }, saved]);
  });

  it('startBreak drops a break under a minute old instead of ending it, as the server does', async () => {
    const blip = makeBreak({ id: 2, startedAt: T0 - 30_000, endedAt: T0 + 270_000 });
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { breaks: [over, blip] }));
    const saved = makeBreak({ id: 3, startedAt: T0, endedAt: T0 + 5 * MINUTE_MS });
    vi.mocked(api.startBreak).mockResolvedValue({ break: saved });
    const { result } = renderStore();
    await settle();
    await act(() => result.current.startBreak(TODAY, 300));
    expect(result.current.days[TODAY]?.breaks).toEqual([over, saved]);
  });

  it('startBreak adds nothing and raises the banner when the server refuses', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay());
    vi.mocked(api.startBreak).mockRejectedValue(new Error('A focus timer is running.'));
    const { result } = renderStore();
    await settle();
    await act(() => result.current.startBreak(TODAY, 300));
    expect(result.current.days[TODAY]?.breaks).toEqual([]);
    expect(warnQuietly).toHaveBeenCalledWith(expect.objectContaining({ title: SAVE_FAILED.title }));
    // Asked for again, like after every refused save: the server may have moved on.
    expect(api.getDay).toHaveBeenCalledTimes(2);
  });

  it('endBreak ends the break on screen at once, then takes the end the server stored', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { breaks: [over, running] }));
    const answer = deferred<BreakResponse>();
    vi.mocked(api.endBreak).mockReturnValue(answer.promise);
    const { result } = renderStore();
    await settle();
    const done = begin(() => result.current.endBreak(TODAY, 2));
    expect(result.current.days[TODAY]?.breaks).toEqual([over, { ...running, endedAt: T0 }]);
    expect(api.endBreak).not.toHaveBeenCalled();
    await settle();
    expect(api.endBreak).toHaveBeenCalledWith(2);
    // A focus session starting on another device ended it a little earlier.
    answer.resolve({ break: { ...running, endedAt: T0 - 30_000 } });
    await act(() => done);
    expect(result.current.days[TODAY]?.breaks).toEqual([over, { ...running, endedAt: T0 - 30_000 }]);
  });

  it('endBreak drops a break under a minute old at once, and the server has the last word', async () => {
    const blip = makeBreak({ id: 2, startedAt: T0 - 30_000, endedAt: T0 + 270_000 });
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { breaks: [over, blip] }));
    const answer = deferred<BreakEndResponse>();
    vi.mocked(api.endBreak).mockReturnValueOnce(answer.promise);
    const { result } = renderStore();
    await settle();
    const done = begin(() => result.current.endBreak(TODAY, 2));
    expect(result.current.days[TODAY]?.breaks).toEqual([over]);
    answer.resolve({ break: null });
    await act(() => done);
    expect(result.current.days[TODAY]?.breaks).toEqual([over]);

    // The server's clock put it past the minute, so it stays. Meanwhile a break started on another
    // device ended it, and a refresh brought that break in before the answer. The running break
    // is the last in the list (runningBreak), so the answer goes back in before it.
    const phone = makeBreak({ id: 3, startedAt: T0 + 40_000, endedAt: T0 + 40_000 + 5 * MINUTE_MS });
    const kept = { ...blip, endedAt: phone.startedAt };
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { breaks: [over, blip] }));
    await act(() => result.current.load(TODAY));
    const stored = deferred<BreakEndResponse>();
    vi.mocked(api.endBreak).mockReturnValueOnce(stored.promise);
    const ended = begin(() => result.current.endBreak(TODAY, 2));
    await settle();
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { breaks: [over, kept, phone] }));
    await act(() => result.current.load(TODAY));
    expect(result.current.days[TODAY]?.breaks).toEqual([over, phone]);
    stored.resolve({ break: kept });
    await act(() => ended);
    expect(result.current.days[TODAY]?.breaks).toEqual([over, kept, phone]);
  });

  it('a session starting ends the running break, or drops it under a minute, as the server does', async () => {
    const blip = makeBreak({ id: 2, startedAt: T0 - 30_000, endedAt: T0 + 270_000 });
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { breaks: [over, running] }));
    const { result } = renderStore();
    await settle();
    act(() => result.current.applySession(makeSession({ id: 5, startedAt: T0 })));
    expect(result.current.days[TODAY]?.breaks).toEqual([over, { ...running, endedAt: T0 }]);
    // A finished session leaves breaks as they are.
    act(() => result.current.applySession(endSession(makeSession({ id: 5, startedAt: T0 }), { endedAt: T0 + MINUTE_MS, durationSeconds: 60 })));
    expect(result.current.days[TODAY]?.breaks).toEqual([over, { ...running, endedAt: T0 }]);

    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { breaks: [over, blip] }));
    await act(() => result.current.load(TODAY));
    act(() => result.current.applySession(makeSession({ id: 6, startedAt: T0 })));
    expect(result.current.days[TODAY]?.breaks).toEqual([over]);
  });

  it('a session starting ends the break still running on the day before, and leaves the other days as they are', async () => {
    const late = makeBreak({ id: 3, date: YESTERDAY, plannedSeconds: 600, startedAt: MIDNIGHT - 5 * MINUTE_MS, endedAt: MIDNIGHT + 5 * MINUTE_MS });
    const done = makeBreak({ id: 1, date: OTHER, startedAt: new Date(2026, 8, 25, 9, 0).getTime(), endedAt: new Date(2026, 8, 25, 9, 5).getTime() });
    vi.mocked(api.getDay).mockImplementation((date) => Promise.resolve(makeDay(date, { breaks: date === YESTERDAY ? [late] : [done] })));
    const { result } = renderStore(null);
    await act(() => result.current.load(YESTERDAY));
    await act(() => result.current.load(OTHER));
    const other = result.current.days[OTHER];
    // The session's own day isn't loaded: nothing is made up for it.
    const session = makeSession({ id: 5, startedAt: MIDNIGHT + 2 * MINUTE_MS });
    act(() => result.current.applySession(session));
    expect(result.current.days[YESTERDAY]?.breaks).toEqual([{ ...late, endedAt: MIDNIGHT + 2 * MINUTE_MS }]);
    expect(result.current.days[OTHER]).toBe(other);
    expect(result.current.days[TODAY]).toBeUndefined();
    // The session's later answers (a pause) find no break running past its start.
    const ended = result.current.days[YESTERDAY];
    act(() => result.current.applySession({ ...session, pausedAt: MIDNIGHT + 3 * MINUTE_MS }));
    expect(result.current.days[YESTERDAY]).toBe(ended);
    expect(api.getDay).toHaveBeenCalledTimes(2);
  });

  it('removeBreak drops the row before the server answers', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { breaks: [over, running] }));
    const answer = deferred<OkResponse>();
    vi.mocked(api.deleteBreak).mockReturnValue(answer.promise);
    const { result } = renderStore();
    await settle();
    const done = begin(() => result.current.removeBreak(TODAY, 1));
    expect(result.current.days[TODAY]?.breaks).toEqual([running]);
    answer.resolve({ ok: true });
    await act(() => done);
    expect(result.current.days[TODAY]?.breaks).toEqual([running]);
    expect(api.deleteBreak).toHaveBeenCalledWith(1);
  });

  it('removeBreak and endBreak count a 404 as done, since another device deleted the break, and any other refusal as not saved', async () => {
    const third = makeBreak({ id: 3, startedAt: T0 - 20 * MINUTE_MS, endedAt: T0 - 15 * MINUTE_MS });
    vi.mocked(api.getDay).mockResolvedValueOnce(makeDay(TODAY, { breaks: [over, third, running] }));
    vi.mocked(api.deleteBreak).mockRejectedValueOnce(apiError(404)).mockRejectedValueOnce(apiError(500));
    vi.mocked(api.endBreak).mockRejectedValueOnce(apiError(404));
    const { result } = renderStore();
    await settle();
    await act(() => result.current.removeBreak(TODAY, 1));
    await act(() => result.current.endBreak(TODAY, 2));
    expect(result.current.days[TODAY]?.breaks).toEqual([third]);
    expect(warnQuietly).not.toHaveBeenCalled();
    expect(api.getDay).toHaveBeenCalledTimes(1);

    vi.mocked(api.getDay).mockResolvedValueOnce(makeDay(TODAY, { breaks: [third] }));
    await act(() => result.current.removeBreak(TODAY, 3));
    await settle();
    expect(result.current.days[TODAY]?.breaks).toEqual([third]);
    expect(warnQuietly).toHaveBeenCalledWith(expect.objectContaining({ tag: 'save-failed' }));
    expect(api.getDay).toHaveBeenCalledTimes(2);
  });
});

describe('readRange', () => {
  it('lands on the days held when it went out, as empty where the answer has none, and adds no other day', async () => {
    const tue = '2026-09-29';
    vi.mocked(api.getDay).mockImplementation((date) => Promise.resolve(makeDay(date, { retroNote: 'held' })));
    vi.mocked(api.getRange).mockResolvedValue({ days: [makeDay(OTHER, { retroNote: 'range' }), makeDay(tue, { retroNote: 'range' })] });
    const { result } = renderStore(null);
    await act(() => result.current.load(OTHER));
    await act(() => result.current.load(TODAY));
    let days!: Day[];
    await act(async () => {
      days = await result.current.readRange(OTHER, tue);
    });
    expect(days.map((d) => d.date)).toEqual([OTHER, tue]);
    expect(result.current.days[OTHER]?.retroNote).toBe('range');
    expect(result.current.days[TODAY]?.retroNote).toBe('');
    expect(result.current.days[tue]).toBeUndefined();

    vi.mocked(api.getRange).mockRejectedValueOnce(new Error('Request failed (500)'));
    await expect(act(() => result.current.readRange(OTHER, tue))).rejects.toThrow('Request failed (500)');
    expect(warnQuietly).not.toHaveBeenCalled();
  });
});

describe('pruneBefore', () => {
  it('sends the prune, reads the held days before the cutoff again, and moves generation', async () => {
    vi.mocked(api.getDay).mockImplementation((date) => Promise.resolve(makeDay(date, { retroNote: 'stored' })));
    vi.mocked(api.pruneDays).mockResolvedValue({ deleted: 1 });
    const { result } = renderStore(null);
    await act(() => result.current.load(OTHER));
    await act(() => result.current.load(TODAY));
    // The server has nothing before the cutoff now.
    vi.mocked(api.getDay).mockImplementation((date) => Promise.resolve(makeDay(date, date < TODAY ? {} : { retroNote: 'stored' })));
    let pruned!: PruneResult;
    await act(async () => {
      pruned = await result.current.pruneBefore(TODAY);
    });
    await settle();
    expect(api.pruneDays).toHaveBeenCalledWith(TODAY);
    expect(pruned).toEqual({ deleted: 1 });
    expect(vi.mocked(api.getDay).mock.calls.map(([d]) => d)).toEqual([OTHER, TODAY, OTHER]);
    expect(result.current.days[OTHER]?.retroNote).toBe('');
    expect(result.current.days[TODAY]?.retroNote).toBe('stored');
    expect(result.current.generation).toBe(1);
  });

  it('drops a read sent before the prune, and asks again', async () => {
    vi.mocked(api.getDay).mockResolvedValueOnce(makeDay(OTHER, { retroNote: 'stored' }));
    vi.mocked(api.pruneDays).mockResolvedValue({ deleted: 1 });
    const { result } = renderStore(null);
    await act(() => result.current.load(OTHER));
    const out = deferred<Day>();
    const again = deferred<Day>();
    vi.mocked(api.getDay).mockReturnValueOnce(out.promise).mockReturnValueOnce(again.promise);
    const refreshed = begin(() => result.current.refresh(OTHER));
    await act(() => result.current.pruneBefore(TODAY));
    // The read after the prune shares the one already out.
    expect(api.getDay).toHaveBeenCalledTimes(2);
    out.resolve(makeDay(OTHER, { retroNote: 'read before the prune' }));
    await act(() => refreshed);
    expect(result.current.days[OTHER]?.retroNote).toBe('stored');
    expect(api.getDay).toHaveBeenCalledTimes(3);
    again.resolve(makeDay(OTHER));
    await settle();
    expect(result.current.days[OTHER]?.retroNote).toBe('');
  });

  it('rejects when the server refuses, and reads nothing again', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay(OTHER));
    vi.mocked(api.pruneDays).mockRejectedValue(new Error('Request failed (500)'));
    const { result } = renderStore(null);
    await act(() => result.current.load(OTHER));
    await expect(act(() => result.current.pruneBefore(TODAY))).rejects.toThrow('Request failed (500)');
    expect(result.current.generation).toBe(0);
    expect(api.getDay).toHaveBeenCalledTimes(1);
  });
});

describe('useRefreshDay', () => {
  function renderRefresh() {
    return renderHook(
      () => {
        useDay(TODAY);
        return useRefreshDay(TODAY);
      },
      { wrapper: SettingsAndDays },
    );
  }

  it('loads today on the next minute after a failed first load, so its alarms come back', async () => {
    vi.mocked(api.getDay).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(makeDay());
    const { result } = renderHook(
      () => {
        useRefreshDay(TODAY);
        return useDay(TODAY).day;
      },
      { wrapper: SettingsAndDays },
    );
    await settle();
    expect(result.current).toBeUndefined();
    await settle(MINUTE_MS);
    expect(result.current).toBeDefined();
  });

  it('refreshes when the tab comes back, pending until the answer', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay());
    const { result } = renderRefresh();
    await settle();
    const answer = deferred<Day>();
    vi.mocked(api.getDay).mockReturnValueOnce(answer.promise);
    act(() => setVisibility('hidden'));
    expect(api.getDay).toHaveBeenCalledTimes(1);
    act(() => setVisibility('visible'));
    expect(result.current).toBe(true);
    expect(api.getDay).toHaveBeenCalledTimes(2);
    answer.resolve(makeDay());
    await settle();
    expect(result.current).toBe(false);
  });
});

it('useDayStore() stays the same object when a refresh changes a day', async () => {
  vi.mocked(api.getDay)
    .mockResolvedValueOnce(makeDay())
    .mockResolvedValueOnce(makeDay(TODAY, { retroNote: 'from the phone' }));
  const { result } = renderHook(() => ({ store: useDayStore(), days: useDays().days }), { wrapper: SettingsAndDays });
  const store = result.current.store;
  await act(() => store.load(TODAY));
  await act(() => store.refresh(TODAY));
  expect(result.current.days[TODAY]?.retroNote).toBe('from the phone');
  expect(result.current.store).toBe(store);
});

it('useDayStore refuses to run outside the provider', () => {
  expect(() => renderHook(() => useDayStore())).toThrow('useDayStore outside DayProvider');
});

it('useDays refuses to run outside the provider', () => {
  expect(() => renderHook(() => useDays())).toThrow('useDays outside DayProvider');
});
