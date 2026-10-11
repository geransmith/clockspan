// @vitest-environment happy-dom
import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { warnSaveFailed } from '../lib/alerts';
import { ADD_PRIORITY_FAILED, SAVE_FAILED } from '../lib/copy';
import { mergePriorities } from '../../../shared/priorities.js';
import { MAX_PRIORITIES } from '../../../shared/settings.js';
import {
  answered,
  apiError,
  begin,
  deferred,
  deferredAnswer,
  echoPriorities,
  endSession,
  makeDay,
  makePriority,
  makeSession,
  rowUid,
  settle,
  TODAY,
  YESTERDAY,
} from '../test/hooks';
import type { Day, Priority } from '../types';
import { OTHER, renderStore } from './useDay.testkit';

vi.mock('../api');
vi.mock('../lib/alerts');

describe('priorities', () => {
  it('setPriorities says whether the list was saved', async () => {
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay()));
    vi.mocked(api.putPriorities).mockImplementationOnce(echoPriorities).mockRejectedValueOnce(new Error('offline'));
    const { result } = renderStore();
    await settle();
    await act(async () => expect(await result.current.setPriorities(TODAY, [makePriority(1, 'Ship it')], [])).toBe(true));
    expect(result.current.days[TODAY]?.priorities[0]?.text).toBe('Ship it');
    await act(async () => expect(await result.current.setPriorities(TODAY, [makePriority(1, 'Lost')], [makePriority(1, 'Ship it')])).toBe(false));
  });

  it('sends one list at a time, skipping to the newest, and tells every caller it was saved', async () => {
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay()));
    const first = deferredAnswer<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(first.promise).mockImplementation(echoPriorities);
    const { result } = renderStore();
    await settle();
    const saves: Promise<boolean>[] = [];
    const one = [makePriority(1, 'One', { done: true })];
    const two = [...one, makePriority(2, 'Two')];
    act(() => void saves.push(result.current.setPriorities(TODAY, one, [])));
    act(() => void saves.push(result.current.setPriorities(TODAY, two, one)));
    act(() => void saves.push(result.current.setPriorities(TODAY, [...one, makePriority(2, 'Two', { done: true })], two)));
    expect(api.putPriorities).toHaveBeenCalledTimes(1);
    first.resolve({ priorities: vi.mocked(api.putPriorities).mock.calls[0]![1] });
    await act(async () => expect(await Promise.all(saves)).toEqual([true, true, true]));
    expect(api.putPriorities).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.putPriorities).mock.calls[1]?.[1].map((p) => p.done)).toEqual([true, true]);
  });

  it("tells each caller whether the PUT carrying its own list was saved, whatever a later one's did", async () => {
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay()));
    const first = deferredAnswer<{ priorities: Priority[] }>();
    const second = deferredAnswer<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockRejectedValueOnce(new Error('offline'));
    const { result } = renderStore();
    await settle();
    // A timer start's new row goes out and a tick made meanwhile waits behind it, then goes out
    // itself; an untick made while the tick is out waits behind that, and its PUT fails.
    const added = begin(() => result.current.addPriority(TODAY, 'Call the bank'));
    const sent = vi.mocked(api.putPriorities).mock.calls[0]![1];
    const tick = sent.map((p) => ({ ...p, done: p.uid != null }));
    const ticked = begin(() => result.current.setPriorities(TODAY, tick, sent));
    first.resolve({ priorities: sent.filter((p) => p.uid != null) });
    await settle();
    expect(api.putPriorities).toHaveBeenCalledTimes(2);
    const unticked = begin(() => result.current.setPriorities(TODAY, sent, tick));
    second.resolve({ priorities: tick.filter((p) => p.uid != null) });
    await expect(act(() => added)).resolves.toBe(sent[0]!.uid);
    await expect(act(() => ticked)).resolves.toBe(true);
    await expect(act(() => unticked)).resolves.toBe(false);
    expect(api.putPriorities).toHaveBeenCalledTimes(3);
  });

  it('sends each list with the list it was built on, and nothing else', async () => {
    const stored = [makePriority(1, 'Report')];
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { priorities: stored })));
    vi.mocked(api.putPriorities).mockImplementation(echoPriorities);
    const { result } = renderStore();
    await settle();
    const ticked = [makePriority(1, 'Report', { done: true })];
    await act(() => result.current.setPriorities(TODAY, ticked, stored));
    expect(api.putPriorities).toHaveBeenCalledExactlyOnceWith(TODAY, ticked, stored);
  });

  it("sends a list that took a waiting one's place with the base of the oldest list not sent yet", async () => {
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay()));
    const first = deferredAnswer<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(first.promise).mockImplementation(echoPriorities);
    const { result } = renderStore();
    await settle();
    const one = [makePriority(1, 'One')];
    const two = [...one, makePriority(2, 'Two')];
    const three = [...two, makePriority(3, 'Three')];
    act(() => void result.current.setPriorities(TODAY, one, []));
    // Waits behind the first, with its own base: nothing set after the first has gone out.
    act(() => void result.current.setPriorities(TODAY, two, one));
    // Built on the copy that shows `two`, so `two`'s base still describes every change since.
    act(() => void result.current.setPriorities(TODAY, three, two));
    first.resolve({ priorities: one });
    await settle();
    const texts = (rows: Priority[] | undefined) => rows?.map((p) => p.text);
    expect(vi.mocked(api.putPriorities).mock.calls.map(([, list, base]) => [texts(list), texts(base)])).toEqual([
      [['One'], []],
      [['One', 'Two', 'Three'], ['One']],
    ]);
  });

  it("shows another device's row while a save is out, merged the way the server will store it", async () => {
    const report = makePriority(1, 'Report');
    vi.mocked(api.getDay)
      .mockResolvedValueOnce(answered(makeDay(TODAY, { priorities: [report] })))
      .mockResolvedValueOnce(answered(makeDay(TODAY, { priorities: [report, makePriority(2, 'From the phone', { uid: 'phone0000000' })] })));
    const saved = deferredAnswer<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(saved.promise);
    const { result } = renderStore();
    await settle();
    act(() => void result.current.setPriorities(TODAY, [makePriority(1, 'Report', { done: true }), makePriority(2, 'Email')], [report]));
    await act(() => result.current.refresh(TODAY));
    const shown = () => result.current.days[TODAY]?.priorities.map((p) => [p.position, p.text, p.done]);
    expect(shown()).toEqual([
      [1, 'Report', true],
      [2, 'Email', false],
      [3, 'From the phone', false],
    ]);
  });

  it('shows one row while a save is out where the stored list and the list sent both put a task on it, with the stored counts', async () => {
    const theirs = makePriority(1, 'Invoices', { uid: 'task00000001', listed: 2, logged: 600 });
    vi.mocked(api.getDay)
      .mockResolvedValueOnce(answered(makeDay(TODAY)))
      .mockResolvedValueOnce(answered(makeDay(TODAY, { priorities: [theirs] })));
    vi.mocked(api.putPriorities).mockReturnValueOnce(deferredAnswer<{ priorities: Priority[] }>().promise);
    const { result } = renderStore();
    await settle();
    // Both took the left-open offer: one task, the same uid.
    act(() => void result.current.setPriorities(TODAY, [makePriority(1, 'Invoices', { uid: 'task00000001', listed: 0 }), makePriority(2, 'Email')], []));
    await act(() => result.current.refresh(TODAY));
    expect(result.current.days[TODAY]?.priorities.map((p) => [p.position, p.text, p.uid, p.listed, p.logged])).toEqual([
      [1, 'Invoices', 'task00000001', 2, 600],
      [2, 'Email', rowUid(2), 1, 0],
    ]);
  });

  it('shows the list the server answers, a row it dropped included: a task deleted on another device', async () => {
    const report = makePriority(1, 'Report');
    const deleted = makePriority(2, 'Deleted elsewhere');
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { priorities: [report, deleted] })));
    vi.mocked(api.putPriorities).mockResolvedValueOnce(answered({ priorities: [{ ...report, done: true }] }));
    const { result } = renderStore();
    await settle();
    await act(async () =>
      expect(
        await result.current.setPriorities(
          TODAY,
          [
            { ...report, done: true },
            { ...deleted, done: true },
          ],
          [report, deleted],
        ),
      ).toBe(true),
    );
    expect(result.current.days[TODAY]?.priorities).toEqual([{ ...report, done: true }]);
    expect(warnSaveFailed).not.toHaveBeenCalled();
    expect(api.getDay).toHaveBeenCalledTimes(1);
  });

  it('shows a list the merge takes past the most rows a day holds until the server refuses it, then reads the day again', async () => {
    const mine = Array.from({ length: MAX_PRIORITIES }, (_, i) => makePriority(i + 1, `Row ${i + 1}`));
    const phone = makePriority(1, 'From the phone', { uid: 'phone0000000' });
    vi.mocked(api.getDay)
      .mockResolvedValueOnce(answered(makeDay(TODAY)))
      .mockResolvedValueOnce(answered(makeDay(TODAY, { priorities: [phone] })))
      .mockResolvedValueOnce(answered(makeDay(TODAY, { priorities: [phone] })));
    const refused = deferredAnswer<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(refused.promise);
    const { result } = renderStore();
    await settle();
    act(() => void result.current.setPriorities(TODAY, mine, []));
    await act(() => result.current.refresh(TODAY));
    expect(result.current.days[TODAY]?.priorities).toHaveLength(MAX_PRIORITIES + 1);
    refused.reject(apiError(409));
    await settle();
    expect(warnSaveFailed).toHaveBeenCalledOnce();
    expect(api.getDay).toHaveBeenCalledTimes(3);
    expect(result.current.days[TODAY]?.priorities).toEqual([phone]);
  });

  it("keeps every change when lists built on the shown copy take each other's place, and another device writes meanwhile", async () => {
    // The server, merging as the route does, with the phone writing to it while the first save is out.
    let onServer = [makePriority(1, 'Report')];
    const serve = (list: Priority[], base: Priority[] | undefined) => {
      onServer = mergePriorities(onServer, base ?? onServer, list);
      return { priorities: onServer };
    };
    const gate = deferred<void>();
    vi.mocked(api.getDay).mockImplementation(() => Promise.resolve(answered(makeDay(TODAY, { priorities: onServer }))));
    vi.mocked(api.putPriorities)
      .mockImplementationOnce(async (_date, list, base) => {
        await gate.promise;
        return answered(serve(list, base));
      })
      .mockImplementation((_date, list, base) => Promise.resolve(answered(serve(list, base))));
    const { result } = renderStore();
    await settle();
    const shown = () => result.current.days[TODAY]!.priorities;

    // The card ticks Report; that save is out.
    act(() => void result.current.setPriorities(TODAY, [makePriority(1, 'Report', { done: true })], shown()));
    onServer = [...onServer, makePriority(2, 'From the phone', { uid: 'phone0000000' })];
    // The card types a row on the copy it shows; that list waits.
    act(() => void result.current.setPriorities(TODAY, [...shown(), makePriority(2, 'Email')], shown()));
    // A timer start on a new name builds on the copy shown now and takes the waiting list's place.
    const added = begin(() => result.current.addPriority(TODAY, 'From the timer'));
    gate.resolve();
    await act(() => added);
    expect(vi.mocked(api.putPriorities).mock.lastCall![2]?.map((p) => p.text)).toEqual(['Report']);
    const texts = shown().map((p) => [p.text, p.done]);
    expect(texts).toEqual([
      ['Report', true],
      ['Email', false],
      ['From the timer', false],
      ['From the phone', false],
    ]);
    expect(onServer.map((p) => p.text)).toEqual(['Report', 'Email', 'From the timer', 'From the phone']);
  });

  it('addPriority puts a task typed new in the first free row and resolves to its uid', async () => {
    const first = makePriority(1, 'First');
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { priorities: [first] })));
    vi.mocked(api.putPriorities).mockImplementation(echoPriorities);
    const { result } = renderStore();
    await settle();
    let uid = '';
    await act(async () => {
      uid = await result.current.addPriority(TODAY, 'From the timer');
    });
    expect(uid).toMatch(/^[0-9a-f]{12}$/);
    const rows = result.current.days[TODAY]!.priorities;
    expect(rows.map((p) => p.text)).toEqual(['First', 'From the timer']);
    expect(rows[1]).toEqual(makePriority(2, 'From the timer', { uid, listed: 0 }));
    expect(api.putPriorities).toHaveBeenCalledExactlyOnceWith(TODAY, [...rows, expect.objectContaining({ uid: null, text: '' })], [first]);
  });

  it('addPriority writes the row in the category it is given, and sends it', async () => {
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { priorities: [makePriority(1, 'First')] })));
    vi.mocked(api.putPriorities).mockImplementation(echoPriorities);
    const { result } = renderStore();
    await settle();
    let uid = '';
    await act(async () => {
      uid = await result.current.addPriority(TODAY, 'From the timer', 'cat000000001');
    });
    expect(vi.mocked(api.putPriorities).mock.lastCall![1][1]).toMatchObject({ uid, text: 'From the timer', categoryUid: 'cat000000001' });
    expect(result.current.days[TODAY]!.priorities[1]).toMatchObject({ uid, categoryUid: 'cat000000001' });
  });

  it('addPriority makes a task of its own whatever another device typed: the same text twice is two tasks', async () => {
    const report = makePriority(1, 'Report');
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { priorities: [report] })));
    // The phone added the row since this device last read the day; the server merges as the route does.
    const onServer = [report, makePriority(2, 'Call the bank', { uid: 'phone0000001' })];
    vi.mocked(api.putPriorities).mockImplementation((_date, list, base) => Promise.resolve(answered({ priorities: mergePriorities(onServer, base!, list) })));
    const { result } = renderStore();
    await settle();
    let uid = '';
    await act(async () => {
      uid = await result.current.addPriority(TODAY, 'Call the bank');
    });
    expect(uid).not.toBe('phone0000001');
    expect(result.current.days[TODAY]!.priorities.map((p) => [p.text, p.uid])).toEqual([
      ['Report', report.uid],
      ['Call the bank', uid],
      ['Call the bank', 'phone0000001'],
    ]);
  });

  it('addPriority resolves to its uid when the row is gone by the time the save is answered', async () => {
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { priorities: [makePriority(1, 'First')] })));
    const first = deferredAnswer<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(first.promise).mockImplementation(echoPriorities);
    const { result } = renderStore();
    await settle();
    const added = begin(() => result.current.addPriority(TODAY, 'From the timer'));
    const minted = vi.mocked(api.putPriorities).mock.calls[0]![1][1]!.uid;
    // The card removes the row while its save is out.
    const shown = result.current.days[TODAY]!.priorities;
    const removed = shown.filter((p) => p.uid !== minted);
    act(() => void result.current.setPriorities(TODAY, removed, shown));
    first.resolve({ priorities: vi.mocked(api.putPriorities).mock.calls[0]![1] });
    await expect(act(() => added)).resolves.toBe(minted);
    expect(result.current.days[TODAY]!.priorities.map((p) => p.text)).toEqual(['First']);
  });

  it('addPriority rejects when the list is full, the day is not loaded, or the save fails', async () => {
    const full = Array.from({ length: MAX_PRIORITIES }, (_, i) => makePriority(i + 1, `Row ${i + 1}`));
    // Every later GET is the other day's: its load, then the reload after the failed save.
    vi.mocked(api.getDay)
      .mockResolvedValue(answered(makeDay(OTHER)))
      .mockResolvedValueOnce(answered(makeDay(TODAY, { priorities: full })));
    vi.mocked(api.putPriorities).mockRejectedValue(new Error('offline'));
    const { result } = renderStore();
    await settle();
    await expect(result.current.addPriority(TODAY, 'One more')).rejects.toThrow(ADD_PRIORITY_FAILED.full);
    // A day not loaded has no list to add to: where the row goes depends on the rows already there.
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
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay()));
    const first = deferredAnswer<{ priorities: Priority[] }>();
    const second = deferredAnswer<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderStore();
    await settle();
    let saved = false;
    act(() => {
      void result.current.setPriorities(TODAY, [makePriority(1, 'One')], []);
      void result.current.setPriorities(TODAY, [makePriority(1, 'One'), makePriority(2, 'Two')], [makePriority(1, 'One')]);
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
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay()));
    const refused = deferredAnswer<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(refused.promise);
    const { result } = renderStore();
    await settle();
    let saved!: Promise<void>;
    act(() => {
      void result.current.setPriorities(TODAY, [makePriority(1, 'Lost')], []);
      saved = result.current.prioritiesSaved(TODAY);
    });
    refused.reject(new Error('offline'));
    await act(() => expect(saved).resolves.toBeUndefined());
  });
});

describe('editPriorities', () => {
  beforeEach(() => {
    vi.mocked(api.getDay).mockImplementation((date) => Promise.resolve(answered(makeDay(date))));
    vi.mocked(api.putPriorities).mockImplementation(echoPriorities);
  });

  it('edits the list shown now, padded to the rows a day starts with: one a blur just set and not yet sent', async () => {
    const first = deferredAnswer<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(first.promise).mockImplementation(echoPriorities);
    const { result } = renderStore();
    await settle();
    act(() => void result.current.setPriorities(TODAY, [makePriority(1, 'Report')], []));
    const typed = [makePriority(1, 'Report'), makePriority(2, 'Email')];
    act(() => void result.current.setPriorities(TODAY, typed, [makePriority(1, 'Report')]));
    const seen = vi.fn((rows: Priority[]) => rows.map((p) => (p.uid === typed[1]!.uid ? { ...p, done: true } : p)));
    const edited = begin(() => result.current.editPriorities(TODAY, seen));
    expect(seen.mock.calls[0]![0].map((p) => p.text)).toEqual(['Report', 'Email', '']);
    first.resolve({ priorities: [makePriority(1, 'Report')] });
    await act(async () => expect(await edited).toEqual({ value: 'saved', revision: 0 }));
    expect(vi.mocked(api.putPriorities).mock.lastCall![1].map((p) => [p.text, p.done])).toEqual([
      ['Report', false],
      ['Email', true],
      ['', false],
    ]);
  });

  it('says why an edit sent nothing, or that its save failed', async () => {
    const { result } = renderStore();
    await settle();
    expect(await result.current.editPriorities(OTHER, (rows) => rows)).toEqual({ value: 'notLoaded', revision: 0 });
    expect(await result.current.editPriorities(TODAY, () => null)).toEqual({ value: 'skipped', revision: 0 });
    expect(api.putPriorities).not.toHaveBeenCalled();
    vi.mocked(api.putPriorities).mockRejectedValueOnce(new Error('offline'));
    await act(async () => expect(await result.current.editPriorities(TODAY, (rows) => rows)).toEqual({ value: 'failed', revision: 0 }));
    expect(warnSaveFailed).toHaveBeenCalledOnce();
  });

  it("answers the revision of the PUT that carried its list, not a later list's", async () => {
    const first = deferredAnswer<{ priorities: Priority[] }>();
    const second = deferredAnswer<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockImplementation((_d, priorities) => Promise.resolve(answered({ priorities }, 3)));
    const { result } = renderStore();
    await settle();
    act(() => void result.current.setPriorities(TODAY, [makePriority(1, 'Report')], []));
    const edited = begin(() => result.current.editPriorities(TODAY, (rows) => rows));
    first.resolve({ priorities: [makePriority(1, 'Report')] }, 1);
    await settle();
    act(() => void result.current.setPriorities(TODAY, [makePriority(1, 'Report v2')], [makePriority(1, 'Report')]));
    second.resolve({ priorities: [makePriority(1, 'Report')] }, 2);
    await act(async () => expect(await edited).toEqual({ value: 'saved', revision: 2 }));
    expect(api.putPriorities).toHaveBeenCalledTimes(3);
  });
});

describe('a priorities save that puts a task on a list or takes one off', () => {
  const TOMORROW = '2026-09-29';
  const report = makePriority(1, 'Report', { uid: 'task00000001' });
  const email = makePriority(2, 'Email', { uid: 'task00000002' });

  it('reads again the other held days whose lists hold that task, whose counts of days moved, and no other', async () => {
    const held = [
      makeDay(TODAY, { priorities: [report, email] }),
      makeDay(YESTERDAY, { priorities: [{ ...email, position: 1 }] }),
      makeDay(OTHER, { priorities: [makePriority(1, 'Invoices', { uid: 'task00000003' })] }),
      makeDay(TOMORROW),
    ];
    vi.mocked(api.getDay).mockImplementation((date) => Promise.resolve(answered(held.find((d) => d.date === date)!)));
    vi.mocked(api.putPriorities).mockImplementation(echoPriorities);
    const { result } = renderStore(null);
    for (const d of held) await act(() => result.current.load(d.date));
    const read = () => vi.mocked(api.getDay).mock.calls.map(([d]) => d);
    vi.mocked(api.getDay).mockClear();
    // A save puts Report on tomorrow's list: today's copy has it on one day.
    await act(() => result.current.setPriorities(TOMORROW, [report], []));
    await settle();
    expect(read()).toEqual([TODAY]);
    // A tick puts nothing on and takes nothing off.
    vi.mocked(api.getDay).mockClear();
    await act(() => result.current.setPriorities(TOMORROW, [{ ...report, done: true }], [report]));
    await settle();
    expect(read()).toEqual([]);
    // Email off today's list: yesterday's copy has it on two days.
    await act(() => result.current.setPriorities(TODAY, [report], [report, email]));
    await settle();
    expect(read()).toEqual([YESTERDAY]);
  });
});

describe('a priorities save that renames or files a task', () => {
  it('reads again every held day naming it, the saved one included, and moves generation', async () => {
    // Its time yesterday is the task's logged time on other days.
    const report = makePriority(1, 'Report', { uid: 'task00000001', logged: 1500 });
    const held = [
      makeDay(TODAY, { priorities: [report] }),
      makeDay(YESTERDAY, { sessions: [endSession(makeSession({ id: 2, date: YESTERDAY, priorityUid: report.uid, title: 'Report' }))] }),
      makeDay(OTHER, { priorities: [makePriority(1, 'Email', { uid: 'task00000002' })] }),
    ];
    vi.mocked(api.getDay).mockImplementation((date) => Promise.resolve(answered(held.find((d) => d.date === date)!)));
    vi.mocked(api.putPriorities).mockImplementation(echoPriorities);
    const { result } = renderStore(null);
    for (const d of held) await act(() => result.current.load(d.date));
    // Each day once, whatever a read dropped as stale asked again.
    const read = () => [...new Set(vi.mocked(api.getDay).mock.calls.map(([d]) => d))].sort();
    const save = async (row: Priority, base: Priority) => {
      vi.mocked(api.getDay).mockClear();
      const generation = result.current.generation;
      await act(() => result.current.setPriorities(TODAY, [row], [base]));
      await settle();
      return { read: read(), moved: result.current.generation - generation };
    };
    const changed = { read: [YESTERDAY, TODAY], moved: 1 };
    expect(await save({ ...report, text: 'Report v2' }, report)).toEqual(changed);
    expect(await save({ ...report, categoryUid: 'cat000000001' }, report)).toEqual(changed);
    expect(await save({ ...report, note: 'Ask Kim' }, report)).toEqual(changed);
    // A tick, or spaces typed around the name, change nothing the server holds for the task.
    expect(await save({ ...report, done: true }, report)).toEqual({ read: [], moved: 0 });
    expect(await save({ ...report, text: ' Report ' }, report)).toEqual({ read: [], moved: 0 });
    // A task on no other day, with nothing logged elsewhere: no other day can show its old name.
    const fresh = makePriority(2, 'Draft', { uid: 'task00000003' });
    expect(await save({ ...fresh, text: 'Draft v2' }, fresh)).toEqual({ read: [], moved: 0 });
  });
});

describe('a task changed on the server', () => {
  const TASK = 'task00000001';

  it('reads again each held day whose list or log names it, and no other, and moves generation', async () => {
    const onList = makeDay(TODAY, { priorities: [makePriority(1, 'Report', { uid: TASK })] });
    const inLog = makeDay(YESTERDAY, { sessions: [endSession(makeSession({ id: 2, date: YESTERDAY, priorityUid: TASK, title: 'Report' }))] });
    const other = makeDay(OTHER, { priorities: [makePriority(1, 'Email')] });
    const held = [onList, inLog, other];
    vi.mocked(api.getDay).mockImplementation((date) => Promise.resolve(answered(held.find((d) => d.date === date)!)));
    const { result } = renderStore(null);
    for (const d of held) await act(() => result.current.load(d.date));
    // The server took it off its days and left its time unplanned under its name.
    vi.mocked(api.getDay).mockClear();
    vi.mocked(api.getDay).mockImplementation((date) =>
      Promise.resolve(
        answered(date === TODAY ? makeDay(TODAY) : makeDay(YESTERDAY, { sessions: [endSession(makeSession({ id: 2, date: YESTERDAY, label: 'Report' }))] })),
      ),
    );
    act(() => result.current.taskChanged(TASK, 0));
    await settle();
    expect(
      vi
        .mocked(api.getDay)
        .mock.calls.map(([d]) => d)
        .sort(),
    ).toEqual([YESTERDAY, TODAY]);
    expect(result.current.days[TODAY]!.priorities).toEqual([]);
    expect(result.current.days[YESTERDAY]!.sessions[0]).toMatchObject({ priorityUid: null, label: 'Report' });
    expect(result.current.generation).toBe(1);
  });

  it('drops a read sent before the delete was answered, and asks again', async () => {
    vi.mocked(api.getDay).mockResolvedValueOnce(answered(makeDay(TODAY, { priorities: [makePriority(1, 'Report', { uid: TASK })] })));
    const { result } = renderStore(null);
    await act(() => result.current.load(TODAY));
    const out = deferredAnswer<Day>();
    vi.mocked(api.getDay)
      .mockReturnValueOnce(out.promise)
      .mockResolvedValueOnce(answered(makeDay(TODAY), 1));
    const refreshed = begin(() => result.current.refresh(TODAY));
    act(() => result.current.taskChanged(TASK, 1));
    out.resolve(makeDay(TODAY, { priorities: [makePriority(1, 'Report', { uid: TASK })] }));
    await act(() => refreshed);
    await settle();
    expect(api.getDay).toHaveBeenCalledTimes(3);
    expect(result.current.days[TODAY]!.priorities).toEqual([]);
  });
});
