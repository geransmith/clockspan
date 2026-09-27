// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { dismissByTag, warnQuietly } from '../lib/alerts';
import { SAVE_FAILED } from '../lib/copy';
import { emptyPunches } from '../lib/timeclock';
import { deferred, makeDay, makeSession, makeSettings, MIN, settle, SettingsAndDays, setVisibility, T0, TODAY } from '../test/hooks';
import type { Day, OvertimeResponse, Priority, Punch, PunchesResponse } from '../types';
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
    expect(dismissByTag).toHaveBeenCalledWith('load-failed');
  });

  it('shares one request between callers asking at once', async () => {
    const answer = deferred<Day>();
    vi.mocked(api.getDay).mockReturnValue(answer.promise);
    const { result } = renderStore(null);
    const a = result.current.load(TODAY);
    const b = result.current.load(TODAY);
    expect(b).toBe(a);
    answer.resolve(makeDay());
    await act(() => a);
    expect(api.getDay).toHaveBeenCalledTimes(1);
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

describe('refresh', () => {
  it("adopts the server's copy of a day on screen", async () => {
    vi.mocked(api.getDay)
      .mockResolvedValueOnce(makeDay())
      .mockResolvedValueOnce(makeDay(TODAY, { retroNote: 'from the phone' }));
    const { result } = renderStore();
    await settle();
    await act(() => result.current.refresh(TODAY));
    expect(result.current.days[TODAY]?.retroNote).toBe('from the phone');
  });

  it('sends nothing for a day not loaded yet, one still loading, or while a save is out', async () => {
    const first = deferred<Day>();
    vi.mocked(api.getDay).mockReturnValueOnce(first.promise);
    const { result } = renderStore();
    await result.current.refresh(OTHER);
    await result.current.refresh(TODAY);
    expect(api.getDay).toHaveBeenCalledTimes(1);
    first.resolve(makeDay());
    await settle();

    const save = deferred<OvertimeResponse>();
    vi.mocked(api.putOvertime).mockReturnValueOnce(save.promise);
    void result.current.setOvertimeApproved(TODAY, true);
    await result.current.refresh(TODAY);
    expect(api.getDay).toHaveBeenCalledTimes(1);
    save.resolve({ overtimeApproved: true });
    await settle();
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

describe('setPunches', () => {
  it('shows the punches at once and sends one PUT at a time, skipping to the newest', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay());
    const first = deferred<PunchesResponse>();
    vi.mocked(api.putPunches).mockReturnValueOnce(first.promise).mockResolvedValue({ punches: [] });
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
    first.resolve({ punches: [] });
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

  it('works on a day that was never loaded', async () => {
    vi.mocked(api.putPunches).mockResolvedValue({ punches: [] });
    const { result } = renderStore(null);
    await act(() => result.current.setPunches(OTHER, punchesAt(T0)));
    expect(result.current.days[OTHER]?.punches[0]?.at).toBe(T0);
  });
});

describe('priorities', () => {
  it('setPriorities says whether the list was saved', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay());
    vi.mocked(api.putPriorities).mockResolvedValueOnce({ priorities: [] }).mockRejectedValueOnce(new Error('offline'));
    const { result } = renderStore();
    await settle();
    await act(async () => expect(await result.current.setPriorities(TODAY, [priority(1, 'Ship it')])).toBe(true));
    expect(result.current.days[TODAY]?.priorities[0]?.text).toBe('Ship it');
    await act(async () => expect(await result.current.setPriorities(TODAY, [priority(1, 'Lost')])).toBe(false));
  });

  it('addPriority fills the first empty row and resolves to its uid', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { priorities: [priority(1, 'First')] }));
    vi.mocked(api.putPriorities).mockResolvedValue({ priorities: [] });
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

  it('addPriority rejects when the list is full or the save fails', async () => {
    const full = Array.from({ length: 20 }, (_, i) => priority(i + 1, `Row ${i + 1}`));
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { priorities: full }));
    vi.mocked(api.putPriorities).mockRejectedValue(new Error('offline'));
    const { result } = renderStore();
    await settle();
    await expect(result.current.addPriority(TODAY, 'One more')).rejects.toThrow('The priorities list is full.');
    // A day never loaded starts from an empty list.
    await expect(act(() => result.current.addPriority(OTHER, 'Unsaved'))).rejects.toThrow(SAVE_FAILED.title);
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

  it('updateSession shows the stored row, and on failure only raises the banner', async () => {
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { sessions: [makeSession()] }));
    vi.mocked(api.patchSession)
      .mockResolvedValueOnce({ session: makeSession({ label: 'Stored' }) })
      .mockRejectedValueOnce(new Error('offline'));
    const { result } = renderStore();
    await settle();
    await act(() => result.current.updateSession(1, { label: 'Stored' }));
    expect(result.current.days[TODAY]?.sessions[0]?.label).toBe('Stored');
    await act(() => result.current.updateSession(1, { label: 'Lost' }));
    expect(result.current.days[TODAY]?.sessions[0]?.label).toBe('Stored');
    expect(warnQuietly).toHaveBeenCalledTimes(1);
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
