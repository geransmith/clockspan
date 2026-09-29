// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { dismissByTag, warnQuietly } from '../lib/alerts';
import { ADD_PRIORITY_FAILED, SAVE_FAILED } from '../lib/copy';
import { emptyPunches } from '../lib/timeclock';
import { apiError, deferred, makeBreak, makeDay, makeSession, makeSettings, MIN, settle, SettingsAndDays, setVisibility, T0, TODAY } from '../test/hooks';
import type { BreakEndResponse, BreakResponse, Day, OvertimeResponse, Priority, Punch, PunchesResponse, Session } from '../types';
import { useDay, useDayStore, useRefreshDay } from './useDay';

vi.mock('../api');
vi.mock('../lib/alerts');

const OTHER = '2026-09-25';

/** The store, plus `useDay(date)` so the day loads the way the sheet loads it. */
function renderStore(date: string | null = TODAY) {
  return renderHook(
    () => {
      const store = useDayStore();
      if (date) useDay(date);
      return store;
    },
    { wrapper: SettingsAndDays },
  );
}

/** The server's answer to a list PUT: the list as sent, which is what it stores. */
const echoPunches = (_date: string, punches: Punch[]) => Promise.resolve({ punches });
const echoPriorities = (_date: string, priorities: Priority[]) => Promise.resolve({ priorities });

const punchesAt = (...at: (number | null)[]): Punch[] => emptyPunches().map((p, i) => ({ ...p, at: at[i] ?? null }));
const priority = (position: number, text: string, patch: Partial<Priority> = {}): Priority => ({
  position,
  text,
  done: false,
  uid: `u${position}`,
  addedAt: T0,
  ...patch,
});

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
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
    // What request() let through for a proxy's sign-in page: normalizing it throws.
    vi.mocked(api.getDay).mockResolvedValueOnce(null as unknown as Day);
    const { result } = renderStore();
    await settle();
    expect(result.current.errors[TODAY]).toBeDefined();
    expect(warnQuietly).toHaveBeenCalledWith(expect.objectContaining({ tag: 'load-failed' }));

    vi.mocked(api.getDay).mockResolvedValueOnce(makeDay());
    await act(() => result.current.load(TODAY));
    expect(api.getDay).toHaveBeenCalledTimes(2);
    expect(result.current.errors).toEqual({});
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
    expect(result.current.errors[TODAY]).toBe('Request failed (502)');
    expect(result.current.days[TODAY]).toBeUndefined();
    expect(warnQuietly).toHaveBeenCalledWith(expect.objectContaining({ tag: 'load-failed' }));
    // useDay does not ask again on its own: the failure is on screen with a Try again button.
    await settle(5 * MIN);
    expect(api.getDay).toHaveBeenCalledTimes(1);

    vi.mocked(api.getDay).mockResolvedValueOnce(makeDay());
    await act(() => result.current.load(TODAY));
    expect(result.current.errors).toEqual({});
    expect(result.current.days[TODAY]).toBeDefined();
  });

  it('keeps showing a loaded day when a reload fails, without a second banner', async () => {
    vi.mocked(api.getDay).mockResolvedValueOnce(makeDay(TODAY, { retroNote: 'kept' }));
    const { result } = renderStore();
    await settle();
    vi.mocked(api.getDay).mockRejectedValueOnce(new Error('offline'));
    await act(() => result.current.load(TODAY));
    expect(result.current.days[TODAY]?.retroNote).toBe('kept');
    expect(result.current.errors).toEqual({});
    expect(warnQuietly).not.toHaveBeenCalled();
  });
});

describe('load after a write', () => {
  it('keeps what was written when a load sent before the write answers after it', async () => {
    vi.mocked(api.getDay).mockResolvedValueOnce(makeDay());
    const { result } = renderStore();
    await settle();
    // The timer's sync asks for the day again, and a punch goes out before it answers.
    const stale = deferred<Day>();
    vi.mocked(api.getDay).mockReturnValueOnce(stale.promise);
    vi.mocked(api.putPunches).mockImplementation(echoPunches);
    let loaded!: Promise<void>;
    act(() => {
      loaded = result.current.load(TODAY);
    });
    await act(() => result.current.setPunches(TODAY, punchesAt(T0)));
    stale.resolve(makeDay());
    await act(() => loaded);
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
    const done = makeSession({ id: 5, status: 'completed', endedAt: T0 + 25 * MIN, durationSeconds: 1500 });
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
    // Clock in goes out, lunch out waits behind it, and then the timer's sync asks for the day.
    let saved!: Promise<void>;
    act(() => {
      void result.current.setPunches(TODAY, punchesAt(T0));
      saved = result.current.setPunches(TODAY, punchesAt(T0, T0 + 240 * MIN));
    });
    let loaded!: Promise<void>;
    act(() => {
      loaded = result.current.load(TODAY);
    });
    // The server has only the clock-in so far.
    stale.resolve(makeDay(TODAY, { punches: punchesAt(T0) }));
    await act(() => loaded);
    expect(result.current.days[TODAY]?.punches[1]?.at).toBe(T0 + 240 * MIN);
    first.resolve({ punches: vi.mocked(api.putPunches).mock.calls[0]![1] });
    await act(() => saved);
    expect(vi.mocked(api.putPunches).mock.calls.map(([, p]) => p[1]?.at)).toEqual([null, T0 + 240 * MIN]);
    expect(result.current.days[TODAY]?.punches[1]?.at).toBe(T0 + 240 * MIN);
  });

  it('puts the stored copy back at once after a failed save, and the reload shares a load already out', async () => {
    vi.mocked(api.getDay).mockResolvedValueOnce(makeDay());
    const { result } = renderStore();
    await settle();
    const out = deferred<Day>();
    vi.mocked(api.getDay).mockReturnValueOnce(out.promise);
    vi.mocked(api.putOvertime).mockRejectedValueOnce(new Error('offline'));
    let loaded!: Promise<void>;
    act(() => {
      loaded = result.current.load(TODAY);
    });
    await act(() => result.current.setOvertimeApproved(TODAY, true));
    // No answer from anywhere yet, and the sheet already shows what the server has.
    expect(result.current.days[TODAY]?.overtimeApproved).toBe(false);
    // A refused save changed nothing on the server, so the load already out answers for it.
    expect(api.getDay).toHaveBeenCalledTimes(2);
    out.resolve(makeDay(TODAY, { retroNote: 'stored' }));
    await act(() => loaded);
    expect(result.current.days[TODAY]).toMatchObject({ overtimeApproved: false, retroNote: 'stored' });
  });

  it('asks once more after a failed save when the load it shared comes back stale', async () => {
    const gone = makeBreak({ id: 1, startedAt: T0 - 30 * MIN, endedAt: T0 - 25 * MIN });
    vi.mocked(api.getDay).mockResolvedValueOnce(makeDay(TODAY, { breaks: [gone] }));
    const { result } = renderStore();
    await settle();
    // The minute's refresh is out when overtime saves and the break's delete is refused: the
    // phone deleted it already.
    const out = deferred<Day>();
    vi.mocked(api.getDay)
      .mockReturnValueOnce(out.promise)
      .mockResolvedValueOnce(makeDay(TODAY, { overtimeApproved: true }));
    vi.mocked(api.putOvertime).mockResolvedValueOnce({ overtimeApproved: true });
    vi.mocked(api.deleteBreak).mockRejectedValueOnce(apiError(404));
    let refreshed!: Promise<void>;
    act(() => {
      refreshed = result.current.refresh(TODAY);
    });
    await act(() => result.current.setOvertimeApproved(TODAY, true));
    await act(() => result.current.removeBreak(TODAY, 1));
    expect(result.current.days[TODAY]?.breaks).toEqual([gone]);
    expect(api.getDay).toHaveBeenCalledTimes(2);
    // Read before the overtime save, so it is dropped: the store asks again.
    out.resolve(makeDay(TODAY, { breaks: [gone] }));
    await act(() => refreshed);
    await settle();
    expect(api.getDay).toHaveBeenCalledTimes(3);
    expect(result.current.days[TODAY]).toMatchObject({ overtimeApproved: true, breaks: [] });
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
    expect(result.current.errors).toEqual({});
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
    let listed!: Promise<boolean>;
    act(() => {
      listed = result.current.setPriorities(TODAY, [priority(1, 'Still here')]);
    });
    await act(() => result.current.setPunches(TODAY, punchesAt(T0)));
    await settle();
    // The reload has the server's copy, from before the priorities PUT: the row is still shown over it.
    expect(result.current.days[TODAY]).toMatchObject({ retroNote: 'reloaded', priorities: [{ text: 'Still here' }] });
    rows.resolve({ priorities: [priority(1, 'Still here')] });
    expect(await act(() => listed)).toBe(true);
    expect(result.current.days[TODAY]?.priorities.map((p) => p.text)).toEqual(['Still here']);
  });
});

describe('refresh', () => {
  it('shares a load already out for a day on screen instead of sending a second', async () => {
    vi.mocked(api.getDay).mockResolvedValueOnce(makeDay());
    const { result } = renderStore();
    await settle();
    // The timer's sync asked for the day, and the minute's refresh comes while that is out.
    const out = deferred<Day>();
    vi.mocked(api.getDay).mockReturnValueOnce(out.promise);
    let loaded!: Promise<void>;
    let refreshed!: Promise<void>;
    act(() => {
      loaded = result.current.load(TODAY);
      refreshed = result.current.refresh(TODAY);
    });
    expect(api.getDay).toHaveBeenCalledTimes(2);
    out.resolve(makeDay(TODAY, { retroNote: 'shared' }));
    await act(() => Promise.all([loaded, refreshed]));
    expect(result.current.days[TODAY]?.retroNote).toBe('shared');
  });

  it("adopts the server's copy of a day on screen", async () => {
    vi.mocked(api.getDay)
      .mockResolvedValueOnce(makeDay())
      .mockResolvedValueOnce(makeDay(TODAY, { retroNote: 'from the phone' }));
    const { result } = renderStore();
    await settle();
    await act(() => result.current.refresh(TODAY));
    expect(result.current.days[TODAY]?.retroNote).toBe('from the phone');
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

  it('drops an answer that a write overtook, and a failure quietly', async () => {
    const answer = deferred<Day>();
    vi.mocked(api.getDay).mockResolvedValueOnce(makeDay()).mockReturnValueOnce(answer.promise);
    vi.mocked(api.putOvertime).mockResolvedValue({ overtimeApproved: true });
    const { result } = renderStore();
    await settle();
    const refreshed = result.current.refresh(TODAY);
    await act(() => result.current.setOvertimeApproved(TODAY, true));
    answer.resolve(makeDay(TODAY, { overtimeApproved: false }));
    await act(() => refreshed);
    expect(result.current.days[TODAY]?.overtimeApproved).toBe(true);

    vi.mocked(api.getDay).mockRejectedValueOnce(new Error('offline'));
    await act(() => result.current.refresh(TODAY));
    expect(result.current.days[TODAY]?.overtimeApproved).toBe(true);
    expect(warnQuietly).not.toHaveBeenCalled();
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
    expect(result.current.errors[TODAY]).toBe('Request failed (504)');
    expect(warnQuietly).toHaveBeenCalledTimes(1);

    vi.mocked(api.getDay).mockResolvedValueOnce(makeDay(TODAY, { retroNote: 'back' }));
    await act(() => result.current.refresh(TODAY));
    expect(result.current.errors).toEqual({});
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
    let done!: Promise<void>;
    act(() => {
      done = result.current.setPunches(TODAY, punchesAt(T0));
    });
    expect(result.current.days[TODAY]?.punches[0]?.at).toBe(T0);
    // Two more edits while the first PUT is out: only the last one is sent after it.
    act(() => void result.current.setPunches(TODAY, punchesAt(T0 + MIN)));
    act(() => void result.current.setPunches(TODAY, punchesAt(T0 + 2 * MIN)));
    expect(api.putPunches).toHaveBeenCalledTimes(1);
    first.resolve({ punches: vi.mocked(api.putPunches).mock.calls[0]![1] });
    await act(() => done);
    expect(vi.mocked(api.putPunches).mock.calls.map(([, p]) => p[0]?.at)).toEqual([T0, T0 + 2 * MIN]);
    expect(result.current.days[TODAY]?.punches[0]?.at).toBe(T0 + 2 * MIN);
  });

  it('stops the queue on a failed save and puts the stored day back', async () => {
    vi.mocked(api.getDay)
      .mockResolvedValueOnce(makeDay())
      .mockResolvedValueOnce(makeDay(TODAY, { punches: punchesAt(T0 - MIN) }));
    const first = deferred<PunchesResponse>();
    vi.mocked(api.putPunches).mockReturnValueOnce(first.promise);
    const { result } = renderStore();
    await settle();
    let done!: Promise<void>;
    act(() => {
      done = result.current.setPunches(TODAY, punchesAt(T0));
    });
    act(() => void result.current.setPunches(TODAY, punchesAt(T0 + MIN)));
    first.reject(new Error('offline'));
    await act(() => done);
    await settle();
    expect(api.putPunches).toHaveBeenCalledTimes(1);
    expect(warnQuietly).toHaveBeenCalledWith(expect.objectContaining({ title: SAVE_FAILED.title, tag: 'save-failed' }));
    expect(result.current.days[TODAY]?.punches[0]?.at).toBe(T0 - MIN);
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
    await act(async () => expect(await result.current.setPriorities(TODAY, [priority(1, 'Ship it')])).toBe(true));
    expect(result.current.days[TODAY]?.priorities[0]?.text).toBe('Ship it');
    await act(async () => expect(await result.current.setPriorities(TODAY, [priority(1, 'Lost')])).toBe(false));
  });

  it('sends one list at a time, skipping to the newest, and tells every caller it was saved', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay());
    const first = deferred<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(first.promise).mockImplementation(echoPriorities);
    const { result } = renderStore();
    await settle();
    const saves: Promise<boolean>[] = [];
    act(() => void saves.push(result.current.setPriorities(TODAY, [priority(1, 'One', { done: true })])));
    act(() => void saves.push(result.current.setPriorities(TODAY, [priority(1, 'One', { done: true }), priority(2, 'Two')])));
    act(() => void saves.push(result.current.setPriorities(TODAY, [priority(1, 'One', { done: true }), priority(2, 'Two', { done: true })])));
    expect(api.putPriorities).toHaveBeenCalledTimes(1);
    first.resolve({ priorities: vi.mocked(api.putPriorities).mock.calls[0]![1] });
    await act(async () => expect(await Promise.all(saves)).toEqual([true, true, true]));
    expect(api.putPriorities).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.putPriorities).mock.calls[1]?.[1].map((p) => p.done)).toEqual([true, true]);
  });

  it('addPriority fills the first empty row and resolves to its uid', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { priorities: [priority(1, 'First')] }));
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
    const full = Array.from({ length: 20 }, (_, i) => priority(i + 1, `Row ${i + 1}`));
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
});

describe('per-day fields', () => {
  it('setRetro keeps the note and stamp it was not asked to change, then takes the stored stamp', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { retroNote: 'why', retroAt: null }));
    const saved = deferred<{ retroNote: string; retroAt: number | null }>();
    vi.mocked(api.putRetro).mockReturnValueOnce(saved.promise);
    const { result } = renderStore();
    await settle();

    let done!: Promise<void>;
    act(() => {
      done = result.current.setRetro(TODAY, { done: true });
    });
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

    vi.mocked(api.putTarget).mockRejectedValueOnce(new Error('offline'));
    let done!: Promise<void>;
    act(() => {
      done = result.current.setWorkMinutes(TODAY, 300);
    });
    expect(result.current.days[TODAY]?.workMinutes).toBe(300);
    await act(() => done);
    await settle();
    // The reload answers with the stored day, which has no length of its own in this mock.
    expect(result.current.days[TODAY]?.workMinutes).toBeNull();
  });

  it("sends a day's field changes one after another, in the order they were made", async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay());
    const on = deferred<OvertimeResponse>();
    vi.mocked(api.putOvertime).mockReturnValueOnce(on.promise).mockResolvedValueOnce({ overtimeApproved: false });
    vi.mocked(api.putTarget).mockResolvedValueOnce({ workMinutes: 240 });
    const { result } = renderStore();
    await settle();
    let done!: Promise<void>;
    act(() => void result.current.setOvertimeApproved(TODAY, true));
    act(() => void result.current.setOvertimeApproved(TODAY, false));
    act(() => {
      done = result.current.setWorkMinutes(TODAY, 240);
    });
    await settle();
    expect(api.putOvertime).toHaveBeenCalledTimes(1);
    expect(api.putTarget).not.toHaveBeenCalled();
    on.resolve({ overtimeApproved: true });
    await act(() => done);
    expect(vi.mocked(api.putOvertime).mock.calls.map(([, v]) => v)).toEqual([true, false]);
    expect(api.putTarget).toHaveBeenCalledWith(TODAY, 240);
    expect(result.current.days[TODAY]).toMatchObject({ overtimeApproved: false, workMinutes: 240 });
  });

  it('setOvertimeApproved is optimistic and reloads the day when the save fails', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay());
    vi.mocked(api.putOvertime).mockRejectedValueOnce(new Error('offline'));
    const { result } = renderStore();
    await settle();
    let done!: Promise<void>;
    act(() => {
      done = result.current.setOvertimeApproved(TODAY, true);
    });
    expect(result.current.days[TODAY]?.overtimeApproved).toBe(true);
    await act(() => done);
    await settle();
    expect(result.current.days[TODAY]?.overtimeApproved).toBe(false);
    expect(api.getDay).toHaveBeenCalledTimes(2);
  });
});

describe('sessions', () => {
  it('applySession inserts, replaces and drops a cancelled row, in start order', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay());
    const { result } = renderStore();
    await settle();
    const later = makeSession({ id: 2, startedAt: T0 + 30 * MIN });
    const earlier = makeSession({ id: 1, startedAt: T0 });
    act(() => result.current.applySession(later));
    act(() => result.current.applySession(earlier));
    expect(result.current.days[TODAY]?.sessions.map((s) => s.id)).toEqual([1, 2]);
    act(() => result.current.applySession({ ...later, label: 'Renamed' }));
    expect(result.current.days[TODAY]?.sessions[1]?.label).toBe('Renamed');
    act(() => result.current.applySession({ ...earlier, status: 'cancelled' }));
    expect(result.current.days[TODAY]?.sessions.map((s) => s.id)).toEqual([2]);
  });

  it('removeSession drops the row before the server answers', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { sessions: [makeSession()] }));
    vi.mocked(api.deleteSession).mockResolvedValue({ ok: true });
    const { result } = renderStore();
    await settle();
    await act(() => result.current.removeSession(TODAY, 1));
    expect(result.current.days[TODAY]?.sessions).toEqual([]);
    expect(api.deleteSession).toHaveBeenCalledWith(1);
  });

  it('updateSession shows the edit at once, keeps the stored row, and puts it back on a failure', async () => {
    const other = makeSession({ id: 2, label: 'Other', startedAt: T0 + 30 * MIN });
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { sessions: [makeSession(), other] }));
    const answer = deferred<{ session: Session }>();
    vi.mocked(api.patchSession).mockReturnValueOnce(answer.promise).mockRejectedValueOnce(new Error('offline'));
    const { result } = renderStore();
    await settle();
    let done!: Promise<void>;
    act(() => {
      done = result.current.updateSession(TODAY, 1, { label: 'Renamed' });
    });
    expect(result.current.days[TODAY]?.sessions.map((x) => x.label)).toEqual(['Renamed', 'Other']);
    answer.resolve({ session: makeSession({ label: 'Renamed (stored)' }) });
    await act(() => done);
    expect(result.current.days[TODAY]?.sessions[0]?.label).toBe('Renamed (stored)');
    // The server now has the stored label, which the reload after the failure brings back too.
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { sessions: [makeSession({ label: 'Renamed (stored)' }), other] }));
    await act(() => result.current.updateSession(TODAY, 1, { label: 'Lost' }));
    expect(result.current.days[TODAY]?.sessions[0]?.label).toBe('Renamed (stored)');
    await settle();
    expect(api.getDay).toHaveBeenCalledTimes(2);
    expect(result.current.days[TODAY]?.sessions[0]?.label).toBe('Renamed (stored)');
    expect(warnQuietly).toHaveBeenCalledTimes(1);
  });
});

describe('breaks', () => {
  const over = makeBreak({ id: 1, startedAt: T0 - 30 * MIN, endedAt: T0 - 25 * MIN });
  const running = makeBreak({ id: 2, startedAt: T0 - 2 * MIN, endedAt: T0 + 3 * MIN });

  it('startBreak shows the break once the server has it, and ends one still running as the server does', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { breaks: [over, running] }));
    const answer = deferred<BreakResponse>();
    vi.mocked(api.startBreak).mockReturnValue(answer.promise);
    const { result } = renderStore();
    await settle();
    let done!: Promise<void>;
    act(() => {
      done = result.current.startBreak(TODAY, 600);
    });
    await settle();
    expect(api.startBreak).toHaveBeenCalledWith(TODAY, 600);
    expect(result.current.days[TODAY]?.breaks).toEqual([over, running]);
    const saved = makeBreak({ id: 3, plannedSeconds: 600, startedAt: T0, endedAt: T0 + 10 * MIN });
    answer.resolve({ break: saved });
    await act(() => done);
    expect(result.current.days[TODAY]?.breaks).toEqual([over, { ...running, endedAt: T0 }, saved]);
  });

  it('startBreak drops a break under a minute old instead of ending it, as the server does', async () => {
    const blip = makeBreak({ id: 2, startedAt: T0 - 30_000, endedAt: T0 + 270_000 });
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { breaks: [over, blip] }));
    const saved = makeBreak({ id: 3, startedAt: T0, endedAt: T0 + 5 * MIN });
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
    let done!: Promise<void>;
    act(() => {
      done = result.current.endBreak(TODAY, 2);
    });
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
    let done!: Promise<void>;
    act(() => {
      done = result.current.endBreak(TODAY, 2);
    });
    expect(result.current.days[TODAY]?.breaks).toEqual([over]);
    answer.resolve({ break: null });
    await act(() => done);
    expect(result.current.days[TODAY]?.breaks).toEqual([over]);

    // The server's clock put it past the minute: it stays, where it belongs in the list.
    const later = makeBreak({ id: 4, startedAt: T0 - 50 * MIN, endedAt: T0 - 45 * MIN });
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { breaks: [later, over, blip] }));
    await act(() => result.current.load(TODAY));
    await settle();
    vi.mocked(api.endBreak).mockResolvedValueOnce({ break: { ...blip, endedAt: T0 + 1000 } });
    await act(() => result.current.endBreak(TODAY, 2));
    expect(result.current.days[TODAY]?.breaks).toEqual([later, over, { ...blip, endedAt: T0 + 1000 }]);
  });

  it('a session starting ends the running break, or drops it under a minute, as the server does', async () => {
    const blip = makeBreak({ id: 2, startedAt: T0 - 30_000, endedAt: T0 + 270_000 });
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { breaks: [over, running] }));
    const { result } = renderStore();
    await settle();
    act(() => result.current.applySession(makeSession({ id: 5, startedAt: T0 })));
    expect(result.current.days[TODAY]?.breaks).toEqual([over, { ...running, endedAt: T0 }]);
    // A finished session leaves breaks as they are.
    act(() => result.current.applySession(makeSession({ id: 5, startedAt: T0, status: 'completed', endedAt: T0 + MIN, durationSeconds: 60 })));
    expect(result.current.days[TODAY]?.breaks).toEqual([over, { ...running, endedAt: T0 }]);

    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { breaks: [over, blip] }));
    await act(() => result.current.load(TODAY));
    act(() => result.current.applySession(makeSession({ id: 6, startedAt: T0 })));
    expect(result.current.days[TODAY]?.breaks).toEqual([over]);
  });

  it('endBreak puts the stored day back when the server does not answer', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { breaks: [running] }));
    vi.mocked(api.endBreak).mockRejectedValue(new Error('offline'));
    const { result } = renderStore();
    await settle();
    await act(() => result.current.endBreak(TODAY, 2));
    await settle();
    expect(warnQuietly).toHaveBeenCalledTimes(1);
    expect(api.getDay).toHaveBeenCalledTimes(2);
    expect(result.current.days[TODAY]?.breaks).toEqual([running]);
  });

  it('removeBreak drops the row before the server answers', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { breaks: [over, running] }));
    vi.mocked(api.deleteBreak).mockResolvedValue({ ok: true });
    const { result } = renderStore();
    await settle();
    await act(() => result.current.removeBreak(TODAY, 1));
    expect(result.current.days[TODAY]?.breaks).toEqual([running]);
    expect(api.deleteBreak).toHaveBeenCalledWith(1);
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

  it('refreshes every minute', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay());
    renderRefresh();
    await settle();
    expect(api.getDay).toHaveBeenCalledTimes(1);
    await settle(MIN);
    expect(api.getDay).toHaveBeenCalledTimes(2);
    await settle(MIN);
    expect(api.getDay).toHaveBeenCalledTimes(3);
  });

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
    await settle(MIN);
    expect(result.current).toBeDefined();
  });

  it('refreshes when the tab comes back, pending until the answer, at most every 5 s', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay());
    const { result, unmount } = renderRefresh();
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

    act(() => setVisibility('visible'));
    expect(result.current).toBe(false);
    expect(api.getDay).toHaveBeenCalledTimes(2);

    unmount();
    await settle(MIN);
    expect(api.getDay).toHaveBeenCalledTimes(2);
  });
});

it('useDayStore refuses to run outside the provider', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(() => renderHook(() => useDayStore())).toThrow('useDayStore outside DayProvider');
});
