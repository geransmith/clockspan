// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as api from '../api';
import { deferred, makeDay, settle, T0, TODAY } from '../test/hooks';
import type { Day, Priority } from '../types';
import { useLeftOpen } from './useLeftOpen';

vi.mock('../api');

const row = (position: number, text: string, done = false): Priority => ({ position, text, done, uid: `uid${position}`.padEnd(12, '0'), addedAt: null });
const friday = makeDay('2026-09-25', { priorities: [row(1, 'Ship it', true), row(2, 'Review the PR')] });

const render = (today = TODAY, wanted = true) =>
  renderHook((p: { today: string; wanted: boolean }) => useLeftOpen(p.today, p.wanted), { initialProps: { today, wanted } });

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

it("offers the last planned day's unticked rows from the two weeks before today", async () => {
  vi.mocked(api.getRange).mockResolvedValue({ days: [friday] });
  const { result } = render();
  expect(result.current.leftOpen).toBeNull();
  await settle();
  expect(api.getRange).toHaveBeenCalledWith('2026-09-14', '2026-09-27');
  expect(result.current.leftOpen).toEqual({ date: '2026-09-25', rows: [row(2, 'Review the PR')] });
});

it('asks nothing while not wanted, and only once a day once it is', async () => {
  vi.mocked(api.getRange).mockResolvedValue({ days: [friday] });
  const { result, rerender } = render(TODAY, false);
  await settle();
  expect(api.getRange).not.toHaveBeenCalled();
  rerender({ today: TODAY, wanted: true });
  await settle();
  rerender({ today: TODAY, wanted: false });
  expect(result.current.leftOpen).toBeNull();
  rerender({ today: TODAY, wanted: true });
  await settle();
  expect(api.getRange).toHaveBeenCalledTimes(1);
  expect(result.current.leftOpen?.date).toBe('2026-09-25');
  // A new day asks again.
  rerender({ today: '2026-09-29', wanted: true });
  expect(result.current.leftOpen).toBeNull();
  await settle();
  expect(api.getRange).toHaveBeenLastCalledWith('2026-09-15', '2026-09-28');
});

it('offers nothing when the fetch fails', async () => {
  vi.mocked(api.getRange).mockRejectedValue(new Error('Request failed (500)'));
  const { result } = render();
  await settle();
  expect(result.current.leftOpen).toBeNull();
});

it('drops an answer that arrives after the offer stopped being wanted', async () => {
  const late = deferred<{ days: Day[] }>();
  vi.mocked(api.getRange).mockReturnValueOnce(late.promise).mockResolvedValueOnce({ days: [] });
  const { result, rerender } = render();
  rerender({ today: TODAY, wanted: false });
  late.resolve({ days: [friday] });
  await settle();
  rerender({ today: TODAY, wanted: true });
  await settle();
  expect(api.getRange).toHaveBeenCalledTimes(2);
  expect(result.current.leftOpen).toBeNull();
});

it('keeps "Start fresh" for the rest of the day, across a reload', async () => {
  vi.mocked(api.getRange).mockResolvedValue({ days: [friday] });
  const { result, rerender, unmount } = render();
  await settle();
  act(() => result.current.dismiss());
  rerender({ today: TODAY, wanted: true });
  expect(result.current.leftOpen).toBeNull();
  unmount();
  const again = render();
  await settle();
  expect(again.result.current.leftOpen).toBeNull();
  expect(api.getRange).toHaveBeenCalledTimes(1);
  // The next day offers again.
  again.rerender({ today: '2026-09-29', wanted: true });
  await settle();
  expect(again.result.current.leftOpen?.date).toBe('2026-09-25');
});
