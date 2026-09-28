// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as api from '../api';
import { makeDay, makeSettings, settle, SettingsAndDays, T0, TODAY } from '../test/hooks';
import { useDay } from './useDay';
import { useWeek } from './useWeek';

vi.mock('../api');

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

it("fetches the week up to the day, and takes the store's copy of a day it holds", async () => {
  // TODAY is a Monday; the sheet shows Wednesday of that week.
  const wed = '2026-09-30';
  vi.mocked(api.getRange).mockResolvedValue({ days: [makeDay(TODAY, { retroNote: 'fetched' }), makeDay(wed, { retroNote: 'fetched' })] });
  vi.mocked(api.getDay).mockImplementation((date) => Promise.resolve(makeDay(date, { retroNote: 'held' })));
  const { result } = renderHook(
    () => {
      useDay(wed);
      // Days the store holds outside Monday..Wednesday are left out: last week's, and a later
      // one (today, while the sheet shows an earlier day).
      useDay('2026-09-25');
      useDay('2026-10-01');
      return useWeek(wed);
    },
    { wrapper: SettingsAndDays },
  );
  expect(result.current).toBeNull();
  await settle();
  expect(api.getRange).toHaveBeenCalledWith(TODAY, wed);
  expect(result.current?.map((d) => [d.date, d.retroNote]).sort()).toEqual([
    [TODAY, 'fetched'],
    [wed, 'held'],
  ]);
});
