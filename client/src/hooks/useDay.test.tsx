// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { warnQuietly, warnSaveFailed } from '../lib/alerts';
import { normalizePunches } from '../lib/timeclock';
import { MINUTE_MS } from '../../../shared/dates.js';
import {
  answered,
  apiError,
  begin,
  deferredAnswer,
  echoPunches,
  endSession,
  makeBreak,
  makeDay,
  makePriority,
  makeSession,
  punchesAt,
  settle,
  SettingsAndDays,
  setVisibility,
  T0,
  TODAY,
} from '../test/hooks';
import type { Day, OvertimeResponse, Priority, PruneResult, PunchesResponse, RangeResponse } from '../types';
import { useDay, useDays, useDayStore, useRefreshDay } from './useDay';
import { OTHER, renderStore } from './useDay.testkit';

vi.mock('../api');
vi.mock('../lib/alerts');

describe('load', () => {
  it('fetches a day on first use and normalizes its punches', async () => {
    // An old day that ended in an unset out/in pair: the pair's out becomes the clock out.
    const legacy = [...punchesAt(T0).slice(0, 3), { position: 3, kind: 'out' as const, at: null }, { position: 4, kind: 'in' as const, at: null }];
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { punches: legacy })));
    const { result } = renderStore();
    await settle();
    expect(api.getDay).toHaveBeenCalledTimes(1);
    expect(result.current.days[TODAY]?.punches.map((p) => p.position)).toEqual([0, 1, 2, 3]);
  });

  it('shares one request between callers asking at once', async () => {
    const answer = deferredAnswer<Day>();
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
    vi.mocked(api.getDay).mockResolvedValueOnce(answered(null as unknown as Day));
    const { result } = renderStore();
    await settle();
    expect(result.current.failed.has(TODAY)).toBe(true);

    vi.mocked(api.getDay).mockResolvedValueOnce(answered(makeDay()));
    await act(() => result.current.load(TODAY));
    expect(api.getDay).toHaveBeenCalledTimes(2);
    expect(result.current.failed.size).toBe(0);
    expect(result.current.days[TODAY]).toBeDefined();
  });

  it('records a failed first load, raises no banner (the view shows it), and waits for Try again', async () => {
    vi.mocked(api.getDay).mockRejectedValueOnce(new Error('Request failed (502)'));
    const { result } = renderStore();
    await settle();
    expect(result.current.failed.has(TODAY)).toBe(true);
    expect(result.current.days[TODAY]).toBeUndefined();
    expect(warnQuietly).not.toHaveBeenCalled();
    // useDay does not ask again on its own: the failure is on screen with a Try again button.
    await settle(5 * MINUTE_MS);
    expect(api.getDay).toHaveBeenCalledTimes(1);

    vi.mocked(api.getDay).mockResolvedValueOnce(answered(makeDay()));
    await act(() => result.current.load(TODAY));
    expect(result.current.failed.size).toBe(0);
    expect(result.current.days[TODAY]).toBeDefined();
  });

  it('keeps showing a loaded day when a reload fails, without a banner', async () => {
    vi.mocked(api.getDay).mockResolvedValueOnce(answered(makeDay(TODAY, { retroNote: 'kept' })));
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
      .mockResolvedValueOnce(answered(makeDay()))
      .mockResolvedValueOnce(answered(makeDay(OTHER)))
      .mockResolvedValueOnce(answered(makeDay(TODAY, { retroNote: 'from the phone' })));
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
      .mockResolvedValueOnce(answered(makeDay(OTHER)))
      .mockRejectedValueOnce(new Error('Request failed (504)'));
    const { result, rerender } = renderDay();
    await settle();
    rerender({ date: OTHER });
    await settle();
    rerender({ date: TODAY });
    await settle();
    expect(api.getDay).toHaveBeenCalledTimes(3);
    expect(result.current.failed).toBe(true);
    expect(warnQuietly).not.toHaveBeenCalled();
  });
});

describe('load after a write', () => {
  it('keeps what was written when a load sent before the write answers after it', async () => {
    vi.mocked(api.getDay).mockResolvedValueOnce(answered(makeDay()));
    const { result } = renderStore();
    await settle();
    // A background read asks for the day again, and a punch goes out before it answers.
    const stale = deferredAnswer<Day>();
    vi.mocked(api.getDay)
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(answered(makeDay(TODAY, { punches: punchesAt(T0) }), 1));
    vi.mocked(api.putPunches).mockImplementation((_date, punches) => Promise.resolve(answered({ punches }, 1)));
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
    const first = deferredAnswer<Day>();
    const again = deferredAnswer<Day>();
    vi.mocked(api.getDay).mockReturnValueOnce(first.promise).mockReturnValueOnce(again.promise);
    const saved = makeBreak({ id: 3 });
    vi.mocked(api.startBreak).mockResolvedValue(answered({ break: saved }, 1));
    const { result } = renderStore();
    await act(() => result.current.startBreak(TODAY, 300));
    expect(result.current.days[TODAY]).toBeUndefined();
    // Read before the break was saved, but the best copy there is: it shows, and the day is asked for again.
    first.resolve(makeDay(TODAY, { punches: punchesAt(T0) }));
    await settle();
    expect(result.current.days[TODAY]?.punches[0]?.at).toBe(T0);
    expect(api.getDay).toHaveBeenCalledTimes(2);
    again.resolve(makeDay(TODAY, { punches: punchesAt(T0), breaks: [saved] }), 1);
    await settle();
    expect(result.current.days[TODAY]?.breaks).toEqual([saved]);
  });

  it('does not make up a day for a session confirmed before its first load, and asks for the day again', async () => {
    // Today's first load is out when the timer's auto-finish comes back.
    const first = deferredAnswer<Day>();
    const done = endSession(makeSession({ id: 5 }), { endedAt: T0 + 25 * MINUTE_MS, durationSeconds: 1500 });
    vi.mocked(api.getDay)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(answered(makeDay(TODAY, { punches: punchesAt(T0), sessions: [done] }), 1));
    const { result } = renderStore();
    act(() => result.current.applySession(done, 1));
    expect(result.current.days[TODAY]).toBeUndefined();
    // The first answer was read before the finish: it has the punches but not the session.
    first.resolve(makeDay(TODAY, { punches: punchesAt(T0) }));
    await settle();
    expect(api.getDay).toHaveBeenCalledTimes(2);
    expect(result.current.days[TODAY]?.punches[0]?.at).toBe(T0);
    expect(result.current.days[TODAY]?.sessions.map((x) => x.id)).toEqual([5]);
  });

  it('keeps a punch waiting to go out when a load sent while it waited answers first', async () => {
    vi.mocked(api.getDay).mockResolvedValueOnce(answered(makeDay()));
    const { result } = renderStore();
    await settle();
    const first = deferredAnswer<PunchesResponse>();
    vi.mocked(api.putPunches).mockReturnValueOnce(first.promise).mockImplementation(echoPunches);
    const stale = deferredAnswer<Day>();
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
    vi.mocked(api.getDay).mockResolvedValueOnce(answered(makeDay()));
    const { result } = renderStore();
    await settle();
    const out = deferredAnswer<Day>();
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
    vi.mocked(api.getDay).mockResolvedValueOnce(answered(makeDay(TODAY, { breaks: [stored] })));
    const { result } = renderStore();
    await settle();
    // A background read is out when overtime saves and the break's delete doesn't reach the server.
    const out = deferredAnswer<Day>();
    vi.mocked(api.getDay)
      .mockReturnValueOnce(out.promise)
      .mockResolvedValueOnce(answered(makeDay(TODAY, { overtimeApproved: true, retroNote: 'from the phone', breaks: [stored] }), 1));
    vi.mocked(api.putOvertime).mockResolvedValueOnce(answered({ overtimeApproved: true }, 1));
    vi.mocked(api.deleteBreak).mockRejectedValueOnce(new Error('offline'));
    const refreshed = begin(() => result.current.refresh(TODAY));
    await act(() => result.current.setOvertimeApproved(TODAY, true));
    await act(() => result.current.removeBreak(TODAY, 1));
    expect(result.current.days[TODAY]?.breaks).toEqual([stored]);
    expect(warnSaveFailed).toHaveBeenCalledOnce();
    expect(api.getDay).toHaveBeenCalledTimes(2);
    // Read before the overtime save, so it is dropped: the store asks again.
    out.resolve(makeDay(TODAY, { breaks: [stored] }));
    await act(() => refreshed);
    await settle();
    expect(api.getDay).toHaveBeenCalledTimes(3);
    expect(result.current.days[TODAY]).toMatchObject({ overtimeApproved: true, retroNote: 'from the phone', breaks: [stored] });
  });

  it('drops a read that left before a refused save, and asks again: a session another device deleted goes', async () => {
    vi.mocked(api.getDay).mockResolvedValueOnce(answered(makeDay(TODAY, { sessions: [makeSession()] }), 1));
    const { result } = renderStore();
    await settle();
    // A background read is out when a rename finds the session deleted on another device.
    const out = deferredAnswer<Day>();
    vi.mocked(api.getDay)
      .mockReturnValueOnce(out.promise)
      .mockResolvedValueOnce(answered(makeDay(TODAY), 3));
    vi.mocked(api.patchSession).mockRejectedValueOnce(apiError(404, 3));
    const refreshed = begin(() => result.current.refresh(TODAY));
    await act(() => result.current.updateSession(TODAY, 1, { label: 'Renamed' }));
    expect(result.current.days[TODAY]?.sessions[0]?.label).toBe('Write the report');
    expect(warnSaveFailed).toHaveBeenCalledOnce();
    // The reload shares the read out.
    expect(api.getDay).toHaveBeenCalledTimes(2);
    // Read before the refusal, which names a higher revision: dropped, and the day asked for again.
    out.resolve(makeDay(TODAY, { sessions: [makeSession()] }), 2);
    await act(() => refreshed);
    await settle();
    expect(api.getDay).toHaveBeenCalledTimes(3);
    expect(result.current.days[TODAY]?.sessions).toEqual([]);
  });

  it('drops a read that answers below what the store held when it went out, and asks no more (a restored backup)', async () => {
    vi.mocked(api.getDay)
      .mockResolvedValueOnce(answered(makeDay(TODAY, { retroNote: 'kept' }), 5))
      .mockResolvedValue(answered(makeDay(TODAY), 3));
    const { result } = renderStore();
    await settle();
    await act(() => result.current.refresh(TODAY));
    await settle();
    expect(api.getDay).toHaveBeenCalledTimes(2);
    expect(result.current.days[TODAY]?.retroNote).toBe('kept');
  });

  it('shows the stored copy, not the change, when the server is down for the save and the reload alike', async () => {
    vi.mocked(api.getDay).mockResolvedValueOnce(answered(makeDay())).mockRejectedValue(new Error('offline'));
    vi.mocked(api.putPunches).mockRejectedValue(new Error('offline'));
    const { result } = renderStore();
    await settle();
    await act(() => result.current.setPunches(TODAY, punchesAt(T0)));
    await settle();
    expect(api.getDay).toHaveBeenCalledTimes(2);
    expect(result.current.days[TODAY]?.punches[0]?.at).toBeNull();
    expect(result.current.failed.size).toBe(0);
    expect(warnQuietly).not.toHaveBeenCalled();
    expect(warnSaveFailed).toHaveBeenCalledOnce();
  });

  it("keeps another list's change on top when a failed save's reload answers first", async () => {
    vi.mocked(api.getDay)
      .mockResolvedValueOnce(answered(makeDay()))
      .mockResolvedValueOnce(answered(makeDay(TODAY, { retroNote: 'reloaded' })));
    vi.mocked(api.putPunches).mockRejectedValueOnce(new Error('offline'));
    const rows = deferredAnswer<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(rows.promise);
    const { result } = renderStore();
    await settle();
    const listed = begin(() => result.current.setPriorities(TODAY, [makePriority(1, 'Still here')], []));
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
      .mockResolvedValueOnce(answered(makeDay()))
      .mockResolvedValueOnce(answered(makeDay(TODAY, { retroNote: 'from the phone' })));
    const { result } = renderStore();
    await settle();
    await act(() => result.current.refresh(TODAY));
    expect(result.current.days[TODAY]?.retroNote).toBe('from the phone');
  });

  it('keeps a day a refresh brings back unchanged, and the state with it', async () => {
    vi.mocked(api.getDay).mockImplementation(() => Promise.resolve(answered(makeDay(TODAY, { punches: punchesAt(T0) }))));
    const { result } = renderStore();
    await settle();
    const before = result.current.days;
    await act(() => result.current.refresh(TODAY));
    expect(api.getDay).toHaveBeenCalledTimes(2);
    expect(result.current.days).toBe(before);
  });

  it('asks again when the read it shared left before another tab or device saved a change', async () => {
    vi.mocked(api.getDay).mockResolvedValueOnce(answered(makeDay(), 1));
    const { result } = renderStore();
    await settle();
    const out = deferredAnswer<Day>();
    vi.mocked(api.getDay)
      .mockReturnValueOnce(out.promise)
      .mockResolvedValueOnce(answered(makeDay(TODAY, { retroNote: 'from the phone' }), 5));
    const refreshed = begin(() => result.current.refresh(TODAY));
    // The live stream heard the phone's save at 5 while that read was out.
    act(() => void window.dispatchEvent(new CustomEvent(api.CHANGED_ELSEWHERE, { detail: 5 })));
    out.resolve(makeDay(), 4);
    await act(() => refreshed);
    await settle();
    expect(api.getDay).toHaveBeenCalledTimes(3);
    expect(result.current.days[TODAY]?.retroNote).toBe('from the phone');
  });

  it('sends nothing for a day not loaded yet, and a change still out stays on top of the answer', async () => {
    const first = deferredAnswer<Day>();
    vi.mocked(api.getDay).mockReturnValueOnce(first.promise);
    const { result } = renderStore();
    await result.current.refresh(OTHER);
    await result.current.refresh(TODAY);
    expect(api.getDay).toHaveBeenCalledTimes(1);
    first.resolve(makeDay());
    await settle();

    // Another device wrote a note; this one is saving overtime meanwhile. Both show.
    const save = deferredAnswer<OvertimeResponse>();
    vi.mocked(api.putOvertime).mockReturnValueOnce(save.promise);
    vi.mocked(api.getDay).mockResolvedValueOnce(answered(makeDay(TODAY, { retroNote: 'from the phone' })));
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
  it('asks again on each refresh while the server is down, and shows the day once it answers', async () => {
    vi.mocked(api.getDay).mockRejectedValueOnce(new Error('Request failed (502)'));
    const { result } = renderStore();
    await settle();

    vi.mocked(api.getDay).mockRejectedValueOnce(new Error('Request failed (504)'));
    await act(() => result.current.refresh(TODAY));
    expect(api.getDay).toHaveBeenCalledTimes(2);
    expect(result.current.failed.has(TODAY)).toBe(true);

    vi.mocked(api.getDay).mockResolvedValueOnce(answered(makeDay(TODAY, { retroNote: 'back' })));
    await act(() => result.current.refresh(TODAY));
    expect(result.current.failed.size).toBe(0);
    expect(result.current.days[TODAY]?.retroNote).toBe('back');
    expect(warnQuietly).not.toHaveBeenCalled();
  });

  it('asks again when the refresh comes before the failure has rendered', async () => {
    vi.mocked(api.getDay)
      .mockRejectedValueOnce(new Error('Request failed (502)'))
      .mockResolvedValueOnce(answered(makeDay(TODAY, { retroNote: 'back' })));
    const { result } = renderStore(null);
    await act(async () => {
      const { load, refresh } = result.current;
      await load(TODAY);
      await refresh(TODAY);
    });
    expect(api.getDay).toHaveBeenCalledTimes(2);
    expect(result.current.days[TODAY]?.retroNote).toBe('back');
  });
});

describe('readRange', () => {
  it('lands on the days it holds loaded when it answers, as empty where the answer has none, and adds no other day', async () => {
    const tue = '2026-09-29';
    vi.mocked(api.getDay).mockImplementation((date) => Promise.resolve(answered(makeDay(date, { retroNote: 'held' }))));
    vi.mocked(api.getRange).mockResolvedValue(answered({ days: [makeDay(OTHER, { retroNote: 'range' }), makeDay(tue, { retroNote: 'range' })] }));
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
    // The answer comes back with the punch rows the store keeps, and the same answer again changes nothing.
    expect(days[0]?.punches).toEqual(result.current.days[OTHER]?.punches);
    expect(days[1]?.punches).toEqual(normalizePunches(makeDay(tue).punches));
    const held = result.current.days;
    await act(() => result.current.readRange(OTHER, tue));
    expect(result.current.days).toBe(held);

    vi.mocked(api.getRange).mockRejectedValueOnce(new Error('Request failed (500)'));
    await expect(act(() => result.current.readRange(OTHER, tue))).rejects.toThrow('Request failed (500)');
    expect(warnQuietly).not.toHaveBeenCalled();
  });

  it('leaves a held day on its own read where the range answered below it', async () => {
    vi.mocked(api.getDay).mockResolvedValueOnce(answered(makeDay(OTHER, { retroNote: 'held' }), 1));
    const { result } = renderStore(null);
    await act(() => result.current.load(OTHER));
    const range = deferredAnswer<RangeResponse>();
    vi.mocked(api.getRange).mockReturnValueOnce(range.promise);
    const read = begin(() => result.current.readRange(OTHER, TODAY));
    // The day's own read went out after the range and answers first.
    vi.mocked(api.getDay).mockResolvedValueOnce(answered(makeDay(OTHER, { retroNote: 'newer' }), 3));
    await act(() => result.current.refresh(OTHER));
    range.resolve({ days: [makeDay(OTHER, { retroNote: 'older' })] }, 2);
    await act(() => read);
    expect(result.current.days[OTHER]?.retroNote).toBe('newer');
  });

  it('leaves a held day not loaded yet to its own load: a range read below a session confirmed on it would make up a day without it', async () => {
    vi.mocked(api.getRange).mockResolvedValueOnce(answered({ days: [makeDay(OTHER)] }, 2));
    const { result } = renderStore(null);
    act(() => result.current.applySession(endSession(makeSession({ id: 5, date: OTHER })), 3));
    await act(() => result.current.readRange(OTHER, TODAY));
    expect(result.current.days[OTHER]).toBeUndefined();
  });
});

describe('pruneBefore', () => {
  it('sends the prune, reads the held days before the cutoff again, and moves generation', async () => {
    vi.mocked(api.getDay).mockImplementation((date) => Promise.resolve(answered(makeDay(date, { retroNote: 'stored' }))));
    vi.mocked(api.pruneDays).mockResolvedValue(answered({ deleted: 1 }));
    const { result } = renderStore(null);
    await act(() => result.current.load(OTHER));
    await act(() => result.current.load(TODAY));
    // The server has nothing before the cutoff now.
    vi.mocked(api.getDay).mockImplementation((date) => Promise.resolve(answered(makeDay(date, date < TODAY ? {} : { retroNote: 'stored' }))));
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
    vi.mocked(api.getDay).mockResolvedValueOnce(answered(makeDay(OTHER, { retroNote: 'stored' })));
    vi.mocked(api.pruneDays).mockResolvedValue(answered({ deleted: 1 }, 1));
    const { result } = renderStore(null);
    await act(() => result.current.load(OTHER));
    const out = deferredAnswer<Day>();
    const again = deferredAnswer<Day>();
    vi.mocked(api.getDay).mockReturnValueOnce(out.promise).mockReturnValueOnce(again.promise);
    const refreshed = begin(() => result.current.refresh(OTHER));
    await act(() => result.current.pruneBefore(TODAY));
    // The read after the prune shares the one already out.
    expect(api.getDay).toHaveBeenCalledTimes(2);
    out.resolve(makeDay(OTHER, { retroNote: 'read before the prune' }));
    await act(() => refreshed);
    expect(result.current.days[OTHER]?.retroNote).toBe('stored');
    expect(api.getDay).toHaveBeenCalledTimes(3);
    again.resolve(makeDay(OTHER), 1);
    await settle();
    expect(result.current.days[OTHER]?.retroNote).toBe('');
  });

  it('rejects when the server refuses, and reads nothing again', async () => {
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(OTHER)));
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
    vi.mocked(api.getDay).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(answered(makeDay()));
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
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay()));
    const { result } = renderRefresh();
    await settle();
    const answer = deferredAnswer<Day>();
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
    .mockResolvedValueOnce(answered(makeDay()))
    .mockResolvedValueOnce(answered(makeDay(TODAY, { retroNote: 'from the phone' })));
  const { result } = renderHook(() => ({ store: useDayStore(), days: useDays().days }), { wrapper: SettingsAndDays });
  const store = result.current.store;
  await act(() => store.load(TODAY));
  await act(() => store.refresh(TODAY));
  expect(result.current.days[TODAY]?.retroNote).toBe('from the phone');
  expect(result.current.store).toBe(store);
});
