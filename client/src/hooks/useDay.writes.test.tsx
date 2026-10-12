// @vitest-environment happy-dom
import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { warnSaveFailed } from '../lib/alerts';
import { mergePunches } from '../../../shared/punches.js';
import { HOUR_MS, MINUTE_MS } from '../../../shared/dates.js';
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
  MIDNIGHT,
  punchesAt,
  settle,
  T0,
  TODAY,
  YESTERDAY,
} from '../test/hooks';
import type {
  BreakEndResponse,
  BreakResponse,
  Day,
  Meeting,
  OfferResponse,
  OkResponse,
  OvertimeResponse,
  Priority,
  Punch,
  PunchesResponse,
  Session,
} from '../types';
import { OTHER, renderStore } from './useDay.testkit';

vi.mock('../api');
vi.mock('../lib/alerts');

describe('setPunches', () => {
  it('shows the punches at once and sends one PUT at a time, skipping to the newest', async () => {
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay()));
    const first = deferredAnswer<PunchesResponse>();
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
      .mockResolvedValueOnce(answered(makeDay()))
      .mockResolvedValueOnce(answered(makeDay(TODAY, { punches: punchesAt(T0 - MINUTE_MS) })));
    const first = deferredAnswer<PunchesResponse>();
    vi.mocked(api.putPunches).mockReturnValueOnce(first.promise);
    const { result } = renderStore();
    await settle();
    const done = begin(() => result.current.setPunches(TODAY, punchesAt(T0)));
    act(() => void result.current.setPunches(TODAY, punchesAt(T0 + MINUTE_MS)));
    first.reject(new Error('offline'));
    await act(() => done);
    await settle();
    expect(api.putPunches).toHaveBeenCalledTimes(1);
    expect(warnSaveFailed).toHaveBeenCalledOnce();
    expect(result.current.days[TODAY]?.punches[0]?.at).toBe(T0 - MINUTE_MS);
  });

  it('sends the list for a day never loaded, as it is, and leaves that day to load from the server', async () => {
    vi.mocked(api.putPunches).mockImplementation(echoPunches);
    const { result } = renderStore(null);
    await act(() => result.current.setPunches(OTHER, punchesAt(T0)));
    // No rows to build on: an empty base leaves the list as sent.
    expect(api.putPunches).toHaveBeenCalledWith(OTHER, punchesAt(T0), []);
    expect(result.current.days[OTHER]).toBeUndefined();
  });

  it("sends the rows it was built on, and shows another device's punch merged the way the server will store it", async () => {
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { punches: punchesAt(T0) })));
    const answer = deferredAnswer<PunchesResponse>();
    vi.mocked(api.putPunches).mockReturnValueOnce(answer.promise);
    const { result } = renderStore();
    await settle();
    const lunchOut = T0 + 180 * MINUTE_MS;
    const clockOut = T0 + 480 * MINUTE_MS;
    const done = begin(() => result.current.setPunches(TODAY, punchesAt(T0, lunchOut)));
    await settle();
    expect(api.putPunches).toHaveBeenCalledWith(TODAY, punchesAt(T0, lunchOut), punchesAt(T0));
    // The phone clocked out meanwhile, and a refresh brings it in under the save still out.
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { punches: punchesAt(T0, null, null, clockOut) })));
    await act(() => result.current.refresh(TODAY));
    expect(result.current.days[TODAY]?.punches).toEqual(punchesAt(T0, lunchOut, null, clockOut));
    answer.resolve({ punches: punchesAt(T0, lunchOut, null, clockOut) });
    await act(() => done);
    expect(result.current.days[TODAY]?.punches).toEqual(punchesAt(T0, lunchOut, null, clockOut));
  });

  it("builds a list set while one is out on the rows shown, so another device's clear of the first list's punch stays", async () => {
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { punches: punchesAt(T0) })));
    const first = deferredAnswer<PunchesResponse>();
    let stored: Punch[] = [];
    // Once the first list is stored, the phone clears its Lunch out: the server merges onto Clock in alone.
    vi.mocked(api.putPunches)
      .mockReturnValueOnce(first.promise)
      .mockImplementation((_date, list, base) => Promise.resolve(answered({ punches: (stored = mergePunches(punchesAt(T0), base, list)) })));
    const { result } = renderStore();
    await settle();
    const lunchOut = T0 + 180 * MINUTE_MS;
    const lunchIn = T0 + 210 * MINUTE_MS;
    act(() => void result.current.setPunches(TODAY, punchesAt(T0, lunchOut)));
    const done = begin(() => result.current.setPunches(TODAY, punchesAt(T0, lunchOut, lunchIn)));
    first.resolve({ punches: punchesAt(T0, lunchOut) });
    await act(() => done);
    expect(stored).toEqual(punchesAt(T0, null, lunchIn));
  });
});

describe('editPunches', () => {
  const lunchOut = (rows: Punch[]) => rows.map((p) => (p.position === 1 ? { ...p, at: T0 + 180 * MINUTE_MS } : p));

  it('hands fn the rows shown now, a list set while another is out included, and saves what it returns', async () => {
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay()));
    const first = deferredAnswer<PunchesResponse>();
    vi.mocked(api.putPunches).mockReturnValueOnce(first.promise).mockImplementation(echoPunches);
    const { result } = renderStore();
    await settle();
    act(() => void result.current.setPunches(TODAY, punchesAt(T0)));
    const fn = vi.fn(lunchOut);
    const done = begin(() => result.current.editPunches(TODAY, fn));
    expect(fn).toHaveBeenCalledWith(punchesAt(T0));
    first.resolve({ punches: punchesAt(T0) });
    expect(await act(() => done)).toBe(true);
    expect(vi.mocked(api.putPunches).mock.calls.map(([, p]) => p)).toEqual([punchesAt(T0), punchesAt(T0, T0 + 180 * MINUTE_MS)]);
  });

  it('sends nothing and resolves false when fn answers null or the store holds no such day', async () => {
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay()));
    const { result } = renderStore();
    await settle();
    await act(async () => expect(await result.current.editPunches(TODAY, () => null)).toBe(false));
    const fn = vi.fn(lunchOut);
    await act(async () => expect(await result.current.editPunches(OTHER, fn)).toBe(false));
    expect(fn).not.toHaveBeenCalled();
    expect(api.putPunches).not.toHaveBeenCalled();
  });
});

describe('per-day fields', () => {
  it('setOvertimeApproved says whether the server saved it', async () => {
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay()));
    vi.mocked(api.putOvertime)
      .mockResolvedValueOnce(answered({ overtimeApproved: true }))
      .mockRejectedValueOnce(new Error('offline'));
    const { result } = renderStore();
    await settle();
    await act(async () => expect(await result.current.setOvertimeApproved(TODAY, true)).toBe(true));
    expect(result.current.days[TODAY]?.overtimeApproved).toBe(true);
    await act(async () => expect(await result.current.setOvertimeApproved(TODAY, false)).toBe(false));
  });

  it("setSnoozedUntil shows its alarm's time beside another's at once, takes the answer's object, and says whether it saved", async () => {
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { snoozedUntil: { lunchBy: T0 } })));
    const saved = deferredAnswer<{ snoozedUntil: Record<string, number> }>();
    vi.mocked(api.putSnooze).mockReturnValueOnce(saved.promise).mockRejectedValueOnce(new Error('offline'));
    const { result } = renderStore();
    await settle();

    const done = begin(() => result.current.setSnoozedUntil(TODAY, 'clockOut', T0 + 5));
    expect(result.current.days[TODAY]?.snoozedUntil).toEqual({ lunchBy: T0, clockOut: T0 + 5 });
    // Another device snoozed the second meal meanwhile: the route answers every alarm's.
    saved.resolve({ snoozedUntil: { lunchBy: T0, clockOut: T0 + 5, secondMeal: T0 + 9 } });
    await act(async () => expect(await done).toBe(true));
    expect(api.putSnooze).toHaveBeenCalledWith(TODAY, 'clockOut', T0 + 5);
    expect(result.current.days[TODAY]?.snoozedUntil).toEqual({ lunchBy: T0, clockOut: T0 + 5, secondMeal: T0 + 9 });

    await act(async () => expect(await result.current.setSnoozedUntil(TODAY, 'lunchBy', T0 + 7)).toBe(false));
  });

  it('setMeeting shows its meeting beside another at once, trimmed, takes the answer, and takes one off with null', async () => {
    const standup = { title: 'Standup', startsAt: T0, endsAt: T0 + 15 * MINUTE_MS };
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { meetings: { aaaa1111: standup } })));
    const call = { title: 'Call', startsAt: T0 + HOUR_MS, endsAt: T0 + 2 * HOUR_MS };
    const saved = deferredAnswer<{ meetings: Record<string, Meeting | null> }>();
    vi.mocked(api.putMeeting).mockReturnValueOnce(saved.promise).mockRejectedValueOnce(new Error('offline'));
    const { result } = renderStore();
    await settle();

    const done = begin(() => result.current.setMeeting(TODAY, 'bbbb2222', { ...call, title: ' Call ' }));
    expect(result.current.days[TODAY]?.meetings).toEqual({ aaaa1111: standup, bbbb2222: call });
    // Another device took the standup off meanwhile: the route answers every meeting.
    saved.resolve({ meetings: { aaaa1111: null, bbbb2222: call } });
    await act(async () => expect(await done).toBe(true));
    expect(api.putMeeting).toHaveBeenCalledWith(TODAY, 'bbbb2222', { ...call, title: ' Call ' });
    expect(result.current.days[TODAY]?.meetings).toEqual({ aaaa1111: null, bbbb2222: call });

    await act(async () => expect(await result.current.setMeeting(TODAY, 'bbbb2222', null)).toBe(false));
  });

  it('setRetro keeps the note and stamp it was not asked to change, then takes the stored stamp', async () => {
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { retroNote: 'why', retroAt: null })));
    const saved = deferredAnswer<{ retroNote: string; retroAt: number | null }>();
    vi.mocked(api.putRetro).mockReturnValueOnce(saved.promise);
    const { result } = renderStore();
    await settle();

    const done = begin(() => result.current.setRetro(TODAY, { done: true }));
    expect(result.current.days[TODAY]).toMatchObject({ retroNote: 'why', retroAt: T0 });
    saved.resolve({ retroNote: 'why', retroAt: T0 - 5 });
    await act(() => done);
    expect(result.current.days[TODAY]?.retroAt).toBe(T0 - 5);

    vi.mocked(api.putRetro).mockResolvedValueOnce(answered({ retroNote: 'why', retroAt: T0 - 5 }));
    act(() => void result.current.setRetro(TODAY, { done: true }));
    expect(result.current.days[TODAY]?.retroAt).toBe(T0 - 5); // already reviewed: the first stamp stays
    await settle();

    vi.mocked(api.putRetro).mockResolvedValueOnce(answered({ retroNote: 'because', retroAt: T0 - 5 }));
    act(() => void result.current.setRetro(TODAY, { note: 'because' }));
    expect(result.current.days[TODAY]).toMatchObject({ retroNote: 'because', retroAt: T0 - 5 });
    await settle();

    vi.mocked(api.putRetro).mockResolvedValueOnce(answered({ retroNote: 'because', retroAt: null }));
    act(() => void result.current.setRetro(TODAY, { done: false }));
    expect(result.current.days[TODAY]?.retroAt).toBeNull();
    await settle();
  });

  it("setOfferAnswered shows a stamp at once, takes the server's first stamp, and keeps one already there", async () => {
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay()));
    const saved = deferredAnswer<OfferResponse>();
    vi.mocked(api.putOffer)
      .mockReturnValueOnce(saved.promise)
      .mockResolvedValueOnce(answered({ offerAnsweredAt: T0 - 5 }));
    const { result } = renderStore();
    await settle();

    const done = begin(() => result.current.setOfferAnswered(TODAY));
    expect(result.current.days[TODAY]?.offerAnsweredAt).toBe(T0);
    // Another device answered first: the server keeps its stamp.
    saved.resolve({ offerAnsweredAt: T0 - 5 });
    await act(async () => expect(await done).toBe(true));
    expect(api.putOffer).toHaveBeenCalledWith(TODAY);
    expect(result.current.days[TODAY]?.offerAnsweredAt).toBe(T0 - 5);

    vi.advanceTimersByTime(MINUTE_MS);
    act(() => void result.current.setOfferAnswered(TODAY));
    expect(result.current.days[TODAY]?.offerAnsweredAt).toBe(T0 - 5);
    await settle();
  });

  it('setOfferAnswered drops the stamp when the save fails, says so, reloads the day and resolves false', async () => {
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay()));
    vi.mocked(api.putOffer).mockRejectedValueOnce(new Error('offline'));
    const { result } = renderStore();
    await settle();
    const done = begin(() => result.current.setOfferAnswered(TODAY));
    expect(result.current.days[TODAY]?.offerAnsweredAt).toBe(T0);
    await act(async () => expect(await done).toBe(false));
    expect(result.current.days[TODAY]?.offerAnsweredAt).toBeNull();
    expect(warnSaveFailed).toHaveBeenCalledTimes(1);
    expect(api.getDay).toHaveBeenCalledTimes(2);
  });

  it('setWorkMinutes is optimistic, and a failed save puts the stored length back', async () => {
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay()));
    vi.mocked(api.putTarget).mockResolvedValueOnce(answered({ workMinutes: 240 }));
    const { result } = renderStore();
    await settle();
    act(() => void result.current.setWorkMinutes(TODAY, 240));
    expect(result.current.days[TODAY]?.workMinutes).toBe(240);
    await settle();
    expect(api.putTarget).toHaveBeenCalledWith(TODAY, 240);

    const reload = deferredAnswer<Day>();
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
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay()));
    const on = deferredAnswer<OvertimeResponse>();
    vi.mocked(api.putOvertime)
      .mockReturnValueOnce(on.promise)
      .mockResolvedValueOnce(answered({ overtimeApproved: false }));
    vi.mocked(api.putTarget).mockResolvedValueOnce(answered({ workMinutes: 240 }));
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
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay()));
    const { result } = renderStore();
    await settle();
    const later = makeSession({ id: 2, startedAt: T0 + 30 * MINUTE_MS });
    const earlier = makeSession({ id: 1, startedAt: T0 });
    act(() => result.current.applySession(later, 0));
    act(() => result.current.applySession(earlier, 0));
    expect(result.current.days[TODAY]?.sessions.map((s) => s.id)).toEqual([1, 2]);
    act(() => result.current.applySession({ ...later, label: 'Renamed' }, 0));
    expect(result.current.days[TODAY]?.sessions[1]?.label).toBe('Renamed');
    act(() => result.current.applySession(endSession(earlier, { status: 'cancelled' }), 0));
    expect(result.current.days[TODAY]?.sessions.map((s) => s.id)).toEqual([2]);
  });

  it('removeSession drops the row before the server answers', async () => {
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { sessions: [makeSession()] })));
    const answer = deferredAnswer<OkResponse>();
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
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { sessions: [makeSession()] })));
    vi.mocked(api.deleteSession).mockRejectedValue(apiError(404));
    const { result } = renderStore();
    await settle();
    await act(() => result.current.removeSession(TODAY, 1));
    await settle();
    expect(result.current.days[TODAY]?.sessions).toEqual([]);
    expect(warnSaveFailed).not.toHaveBeenCalled();
    expect(api.getDay).toHaveBeenCalledTimes(1);
  });

  it('updateSession shows the edit at once, then keeps the stored row', async () => {
    const other = makeSession({ id: 2, label: 'Other', startedAt: T0 + 30 * MINUTE_MS });
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { sessions: [makeSession(), other] })));
    const answer = deferredAnswer<{ session: Session }>();
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
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { sessions: [makeSession()] })));
    const typed = makePriority(1, 'Just typed');
    const rows = deferredAnswer<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(rows.promise);
    vi.mocked(api.patchSession).mockResolvedValueOnce(answered({ session: makeSession({ priorityUid: typed.uid }) }));
    const { result } = renderStore();
    await settle();
    let done!: Promise<boolean>;
    act(() => {
      void result.current.setPriorities(TODAY, [typed], []);
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

  it("updateSession shows a session taken off its task at once under the task's name, as the server stores it", async () => {
    const report = makePriority(1, 'Report', { categoryUid: 'cat000000001' });
    const linked = endSession(makeSession({ id: 4, priorityUid: report.uid, title: 'Report', label: 'Started', categoryUid: 'cat000000001' }));
    const unlinked = { ...linked, priorityUid: null, title: null, label: 'Report', categoryUid: null };
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { priorities: [report], sessions: [linked] })));
    const answer = deferredAnswer<{ session: Session }>();
    vi.mocked(api.patchSession).mockReturnValueOnce(answer.promise);
    const { result } = renderStore();
    await settle();
    const unlink = begin(() => result.current.updateSession(TODAY, 4, { priorityUid: null }));
    expect(result.current.days[TODAY]?.sessions).toEqual([unlinked]);
    answer.resolve({ session: unlinked });
    expect(await act(() => unlink)).toBe(true);
    expect(api.patchSession).toHaveBeenCalledExactlyOnceWith(4, { priorityUid: null });
  });
});

describe('breaks', () => {
  const over = makeBreak({ id: 1, startedAt: T0 - 30 * MINUTE_MS, endedAt: T0 - 25 * MINUTE_MS });
  const running = makeBreak({ id: 2, startedAt: T0 - 2 * MINUTE_MS, endedAt: T0 + 3 * MINUTE_MS });

  it('startBreak shows the break once the server has it, and ends one still running as the server does', async () => {
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { breaks: [over, running] })));
    const answer = deferredAnswer<BreakResponse>();
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
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { breaks: [over, blip] })));
    const saved = makeBreak({ id: 3, startedAt: T0, endedAt: T0 + 5 * MINUTE_MS });
    vi.mocked(api.startBreak).mockResolvedValue(answered({ break: saved }));
    const { result } = renderStore();
    await settle();
    await act(() => result.current.startBreak(TODAY, 300));
    expect(result.current.days[TODAY]?.breaks).toEqual([over, saved]);
  });

  it('startBreak replaces an ended break whose id the new one took (another device deleted it)', async () => {
    const deleted = makeBreak({ id: 7, startedAt: T0 - 30 * MINUTE_MS, endedAt: T0 - 25 * MINUTE_MS });
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { breaks: [deleted] })));
    const saved = makeBreak({ id: 7, startedAt: T0, endedAt: T0 + 5 * MINUTE_MS });
    vi.mocked(api.startBreak).mockResolvedValue(answered({ break: saved }));
    const { result } = renderStore();
    await settle();
    await act(() => result.current.startBreak(TODAY, 300));
    expect(result.current.days[TODAY]?.breaks).toEqual([saved]);
  });

  it('startBreak ends the break still running on the day before, as the server does', async () => {
    const late = makeBreak({ id: 3, date: YESTERDAY, plannedSeconds: 600, startedAt: MIDNIGHT - 5 * MINUTE_MS, endedAt: MIDNIGHT + 5 * MINUTE_MS });
    vi.mocked(api.getDay).mockImplementation((date) => Promise.resolve(answered(makeDay(date, { breaks: date === YESTERDAY ? [late] : [] }))));
    const saved = makeBreak({ id: 4, startedAt: MIDNIGHT + 2 * MINUTE_MS, endedAt: MIDNIGHT + 7 * MINUTE_MS });
    vi.mocked(api.startBreak).mockResolvedValue(answered({ break: saved }));
    const { result } = renderStore();
    await act(() => result.current.load(YESTERDAY));
    await settle();
    await act(() => result.current.startBreak(TODAY, 300));
    expect(result.current.days[YESTERDAY]?.breaks).toEqual([{ ...late, endedAt: MIDNIGHT + 2 * MINUTE_MS }]);
    expect(result.current.days[TODAY]?.breaks).toEqual([saved]);
  });

  it('startBreak adds nothing and raises the banner when the server refuses', async () => {
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay()));
    vi.mocked(api.startBreak).mockRejectedValue(new Error('A focus timer is running.'));
    const { result } = renderStore();
    await settle();
    await act(() => result.current.startBreak(TODAY, 300));
    expect(result.current.days[TODAY]?.breaks).toEqual([]);
    expect(warnSaveFailed).toHaveBeenCalledOnce();
    // Asked for again, like after every refused save: the server may have moved on.
    expect(api.getDay).toHaveBeenCalledTimes(2);
  });

  it('endBreak ends the break on screen at once, then takes the end the server stored', async () => {
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { breaks: [over, running] })));
    const answer = deferredAnswer<BreakResponse>();
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
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { breaks: [over, blip] })));
    const answer = deferredAnswer<BreakEndResponse>();
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
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { breaks: [over, blip] })));
    await act(() => result.current.load(TODAY));
    const stored = deferredAnswer<BreakEndResponse>();
    vi.mocked(api.endBreak).mockReturnValueOnce(stored.promise);
    const ended = begin(() => result.current.endBreak(TODAY, 2));
    await settle();
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { breaks: [over, kept, phone] })));
    await act(() => result.current.load(TODAY));
    expect(result.current.days[TODAY]?.breaks).toEqual([over, phone]);
    stored.resolve({ break: kept });
    await act(() => ended);
    expect(result.current.days[TODAY]?.breaks).toEqual([over, kept, phone]);
  });

  it('a session starting ends the running break, or drops it under a minute, as the server does', async () => {
    const blip = makeBreak({ id: 2, startedAt: T0 - 30_000, endedAt: T0 + 270_000 });
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { breaks: [over, running] })));
    const { result } = renderStore();
    await settle();
    // A finished session leaves a running break as it is.
    act(() => result.current.applySession(endSession(makeSession({ id: 4, startedAt: T0 }), { endedAt: T0 + MINUTE_MS, durationSeconds: 60 }), 0));
    expect(result.current.days[TODAY]?.breaks).toEqual([over, running]);
    act(() => result.current.applySession(makeSession({ id: 5, startedAt: T0 }), 0));
    expect(result.current.days[TODAY]?.breaks).toEqual([over, { ...running, endedAt: T0 }]);

    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { breaks: [over, blip] })));
    await act(() => result.current.load(TODAY));
    act(() => result.current.applySession(makeSession({ id: 6, startedAt: T0 }), 0));
    expect(result.current.days[TODAY]?.breaks).toEqual([over]);
  });

  it('a session starting ends the break still running on the day before, and leaves the other days as they are', async () => {
    const late = makeBreak({ id: 3, date: YESTERDAY, plannedSeconds: 600, startedAt: MIDNIGHT - 5 * MINUTE_MS, endedAt: MIDNIGHT + 5 * MINUTE_MS });
    const done = makeBreak({ id: 1, date: OTHER, startedAt: new Date(2026, 8, 25, 9, 0).getTime(), endedAt: new Date(2026, 8, 25, 9, 5).getTime() });
    vi.mocked(api.getDay).mockImplementation((date) => Promise.resolve(answered(makeDay(date, { breaks: date === YESTERDAY ? [late] : [done] }))));
    const { result } = renderStore(null);
    await act(() => result.current.load(YESTERDAY));
    await act(() => result.current.load(OTHER));
    const other = result.current.days[OTHER];
    // The session's own day isn't loaded: nothing is made up for it.
    const session = makeSession({ id: 5, startedAt: MIDNIGHT + 2 * MINUTE_MS });
    act(() => result.current.applySession(session, 0));
    expect(result.current.days[YESTERDAY]?.breaks).toEqual([{ ...late, endedAt: MIDNIGHT + 2 * MINUTE_MS }]);
    expect(result.current.days[OTHER]).toBe(other);
    expect(result.current.days[TODAY]).toBeUndefined();
    // The session's later answers (a pause) find no break running past its start.
    const ended = result.current.days[YESTERDAY];
    act(() => result.current.applySession({ ...session, pausedAt: MIDNIGHT + 3 * MINUTE_MS }, 0));
    expect(result.current.days[YESTERDAY]).toBe(ended);
    expect(api.getDay).toHaveBeenCalledTimes(2);
  });

  it('removeBreak drops the row before the server answers', async () => {
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { breaks: [over, running] })));
    const answer = deferredAnswer<OkResponse>();
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
    vi.mocked(api.getDay).mockResolvedValueOnce(answered(makeDay(TODAY, { breaks: [over, third, running] })));
    vi.mocked(api.deleteBreak).mockRejectedValueOnce(apiError(404)).mockRejectedValueOnce(apiError(500));
    vi.mocked(api.endBreak).mockRejectedValueOnce(apiError(404));
    const { result } = renderStore();
    await settle();
    await act(() => result.current.removeBreak(TODAY, 1));
    await act(() => result.current.endBreak(TODAY, 2));
    expect(result.current.days[TODAY]?.breaks).toEqual([third]);
    expect(warnSaveFailed).not.toHaveBeenCalled();
    expect(api.getDay).toHaveBeenCalledTimes(1);

    vi.mocked(api.getDay).mockResolvedValueOnce(answered(makeDay(TODAY, { breaks: [third] })));
    await act(() => result.current.removeBreak(TODAY, 3));
    await settle();
    expect(result.current.days[TODAY]?.breaks).toEqual([third]);
    expect(warnSaveFailed).toHaveBeenCalledOnce();
    expect(api.getDay).toHaveBeenCalledTimes(2);
  });
});
