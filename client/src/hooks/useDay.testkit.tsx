import { renderHook } from '@testing-library/react';
import { beforeEach, vi } from 'vitest';
import { SettingsAndDays, T0, TODAY } from '../test/hooks';
import { useDay, useDays, useDayStore } from './useDay';

// What the useDay.*.test.tsx files share, the clock before each test included. Each one mocks
// '../api' and '../lib/alerts' itself, since `vi.mock` applies only in the file that calls it.

export const OTHER = '2026-09-25';

/** The store's functions and state, plus `useDay(date)` so the day loads the way the sheet loads it. */
export function renderStore(date: string | null = TODAY) {
  return renderHook(
    () => {
      const store = { ...useDayStore(), ...useDays() };
      if (date) useDay(date);
      return store;
    },
    { wrapper: SettingsAndDays },
  );
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
