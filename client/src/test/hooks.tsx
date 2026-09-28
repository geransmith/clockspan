import { act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../shared/settings.js';
import { DayProvider } from '../hooks/useDay';
import { SettingsProvider } from '../hooks/useSettings';
import { TimerProvider } from '../hooks/useTimer';
import { emptyPunches } from '../lib/timeclock';
import type { Day, Session, Settings } from '../types';

/**
 * Shared by the hook tests, which run under happy-dom with fake timers. Each test file mocks
 * `../api` (and `../lib/alerts` where banners matter) itself: `vi.mock` only applies in the
 * file that calls it.
 */

/** Monday 28 September 2026, 09:00 local time, so date keys agree in any time zone. */
export const T0 = new Date(2026, 8, 28, 9, 0).getTime();
export const TODAY = '2026-09-28';
export const MIN = 60_000;

export function makeSettings(patch: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

export function makeDay(date = TODAY, patch: Partial<Day> = {}): Day {
  return { date, punches: emptyPunches(), priorities: [], overtimeApproved: false, retroNote: '', retroAt: null, workMinutes: null, sessions: [], ...patch };
}

export function makeSession(patch: Partial<Session> = {}): Session {
  return {
    id: 1,
    date: TODAY,
    label: 'Write the report',
    notes: '',
    plannedSeconds: 25 * 60,
    startedAt: T0,
    endedAt: null,
    status: 'running',
    pausedSeconds: 0,
    pausedAt: null,
    durationSeconds: null,
    priorityUid: null,
    ...patch,
  };
}

/** A promise the test settles by hand, for answers that must arrive in a chosen order. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** An API failure the way `request()` throws one: a status, and the body for a 409. */
export function apiError(status: number, body?: unknown): Error {
  return Object.assign(new Error(`Request failed (${status})`), { status, body });
}

/** Moves the fake clock (0 = just the pending promises) and lets React render what changed. */
export async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Fires `visibilitychange` with the page shown or hidden. */
export function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

export function SettingsAndDays({ children }: { children: ReactNode }) {
  return (
    <SettingsProvider>
      <DayProvider>{children}</DayProvider>
    </SettingsProvider>
  );
}

/** The provider stack as `App.tsx` builds it. */
export function AllProviders({ children }: { children: ReactNode }) {
  return (
    <SettingsAndDays>
      <TimerProvider>{children}</TimerProvider>
    </SettingsAndDays>
  );
}
