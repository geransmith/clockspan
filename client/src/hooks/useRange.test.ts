// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as api from '../api';
import { deferred, makeDay, settle, T0 } from '../test/hooks';
import type { Day } from '../types';
import { useRange } from './useRange';

vi.mock('../api');

const render = (from: string, to: string) => renderHook((p: { from: string; to: string }) => useRange(p.from, p.to), { initialProps: { from, to } });

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
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
