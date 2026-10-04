// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { deferred, makeDay, makeSettings, settle, SettingsAndDays, T0, TODAY } from '../test/hooks';
import type { Day } from '../types';
import { useDay, useDays, useDayStore } from './useDay';
import { useRange } from './useRange';

vi.mock('../api');

const render = (from: string, to: string) =>
  renderHook((p: { from: string; to: string }) => useRange(p.from, p.to), { initialProps: { from, to }, wrapper: SettingsAndDays });

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

it('loads the days of a range', async () => {
  vi.mocked(api.getRange).mockResolvedValue({ days: [makeDay('2026-09-21')] });
  const { result } = render('2026-09-21', '2026-09-27');
  expect(result.current).toEqual({ days: null, error: null });
  await settle();
  expect(api.getRange).toHaveBeenCalledWith('2026-09-21', '2026-09-27');
  expect(result.current.days?.map((d) => d.date)).toEqual(['2026-09-21']);
});

it('reports a failure', async () => {
  vi.mocked(api.getRange).mockRejectedValue(new Error('Request failed (500)'));
  const { result } = render('2026-09-21', '2026-09-27');
  await settle();
  expect(result.current).toEqual({ days: null, error: 'Request failed (500)' });
});

it('reads as loading straight away on a new range, and drops the answer for the old one', async () => {
  const old = deferred<{ days: Day[] }>();
  const failing = deferred<{ days: Day[] }>();
  vi.mocked(api.getRange)
    .mockResolvedValueOnce({ days: [makeDay('2026-09-21')] })
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(failing.promise)
    .mockResolvedValueOnce({ days: [makeDay('2026-10-05')] });
  const { result, rerender } = render('2026-09-21', '2026-09-27');
  await settle();
  rerender({ from: '2026-09-28', to: '2026-10-04' });
  expect(result.current.days).toBeNull();
  rerender({ from: '2026-10-05', to: '2026-10-11' }); // a quick second step
  rerender({ from: '2026-10-05', to: '2026-10-12' });
  old.resolve({ days: [makeDay('2026-09-28')] });
  failing.reject(new Error('late'));
  await settle();
  expect(result.current).toEqual({ days: [makeDay('2026-10-05')], error: null });
});

it("takes the store's copy of a day it holds, in date order, and follows an edit made since", async () => {
  // TODAY is a Monday; the range runs to Wednesday. The store holds Wednesday (answered too),
  // Tuesday (stored since the range was asked for), and two days outside the range.
  const tue = '2026-09-29';
  const wed = '2026-09-30';
  vi.mocked(api.getRange).mockResolvedValue({ days: [makeDay(TODAY, { retroNote: 'fetched' }), makeDay(wed, { retroNote: 'fetched' })] });
  vi.mocked(api.getDay).mockImplementation((date) => Promise.resolve(makeDay(date, { retroNote: 'held' })));
  vi.mocked(api.putRetro).mockResolvedValue({ retroNote: 'edited', retroAt: null });
  const { result } = renderHook(
    () => {
      const { store } = useDay(wed);
      useDay(tue);
      useDay('2026-09-25');
      useDay('2026-10-01');
      return { range: useRange(TODAY, wed), store };
    },
    { wrapper: SettingsAndDays },
  );
  expect(result.current.range.days).toBeNull();
  await settle();
  expect(result.current.range.days?.map((d) => [d.date, d.retroNote])).toEqual([
    [TODAY, 'fetched'],
    [tue, 'held'],
    [wed, 'held'],
  ]);
  await act(() => result.current.store.setRetro(wed, { note: 'edited' }));
  expect(result.current.range.days?.find((d) => d.date === wed)?.retroNote).toBe('edited');
  expect(api.getRange).toHaveBeenCalledTimes(1);
});

describe('held days', () => {
  const tue = '2026-09-29';
  /** The store holds today and Tuesday before the range on Monday to Tuesday is asked for. */
  async function renderHeld() {
    const r = renderHook(
      (p: { from: string; to: string }) => {
        const { store } = useDay(TODAY);
        useDay(tue);
        return { range: useRange(p.from, p.to), store, days: useDays().days };
      },
      { initialProps: { from: '2026-09-21', to: '2026-09-27' }, wrapper: SettingsAndDays },
    );
    await settle();
    return r;
  }

  it("take the range's copy, and a day the answer leaves out (deleted since) shows as empty", async () => {
    vi.mocked(api.getDay).mockImplementation((date) => Promise.resolve(makeDay(date, { retroNote: 'held' })));
    vi.mocked(api.getRange)
      .mockResolvedValueOnce({ days: [] })
      .mockResolvedValueOnce({ days: [makeDay(TODAY, { retroNote: 'from the phone' })] });
    const { result, rerender } = await renderHeld();
    rerender({ from: TODAY, to: tue });
    await settle();
    expect(result.current.range.days?.map((d) => [d.date, d.retroNote])).toEqual([
      [TODAY, 'from the phone'],
      [tue, ''],
    ]);
    expect(result.current.days[TODAY]?.retroNote).toBe('from the phone');
  });

  it('keep a save the server confirmed while the range was out', async () => {
    const answer = deferred<{ days: Day[] }>();
    vi.mocked(api.getDay).mockImplementation((date) => Promise.resolve(makeDay(date)));
    vi.mocked(api.getRange).mockResolvedValueOnce({ days: [] }).mockReturnValueOnce(answer.promise);
    vi.mocked(api.putRetro).mockResolvedValue({ retroNote: 'edited', retroAt: null });
    const { result, rerender } = await renderHeld();
    rerender({ from: TODAY, to: tue });
    await act(() => result.current.store.setRetro(TODAY, { note: 'edited' }));
    answer.resolve({ days: [makeDay(TODAY, { retroNote: 'read before the save' })] });
    await settle();
    expect(result.current.days[TODAY]?.retroNote).toBe('edited');
    expect(result.current.range.days?.find((d) => d.date === TODAY)?.retroNote).toBe('edited');
  });
});

it('asks again after a prune, whose deleted days the answer on screen still holds', async () => {
  vi.mocked(api.getRange)
    .mockResolvedValueOnce({ days: [makeDay('2026-09-22')] })
    .mockResolvedValueOnce({ days: [] });
  vi.mocked(api.pruneDays).mockResolvedValue({ deleted: 1 });
  const { result } = renderHook(() => ({ range: useRange('2026-09-21', '2026-09-27'), store: useDayStore() }), { wrapper: SettingsAndDays });
  await settle();
  expect(result.current.range.days?.map((d) => d.date)).toEqual(['2026-09-22']);
  await act(() => result.current.store.pruneBefore('2026-09-23'));
  await settle();
  expect(api.getRange).toHaveBeenCalledTimes(2);
  expect(result.current.range.days).toEqual([]);
});
