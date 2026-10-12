import { act, renderHook } from '@testing-library/react';
import { beforeEach, vi } from 'vitest';
import * as api from '../api';
import { MINUTE_MS } from '../../../shared/dates.js';
import { answered, AppProviders, makeDay, makeSession, settle, T0, TODAY } from '../test/hooks';
import type { RunningSession, Session } from '../types';
import { useDays, useDayStore } from './useDay';
import { useTimer } from './useTimer';

// What the useTimer.*.test.tsx files share, the clock, today's day and the page's state before
// each test included. Each one mocks '../api' and '../lib/alerts' itself, since `vi.mock` applies
// only in the file that calls it.

export function renderTimer() {
  return renderHook(() => ({ timer: useTimer(), store: { ...useDayStore(), ...useDays() } }), { wrapper: AppProviders });
}

/** Renders with `session` running on the server (every poll says so), and waits for the first sync. */
export async function renderRunning(session: Session | null = makeSession()) {
  vi.mocked(api.getRunning).mockResolvedValue(answered({ session }));
  const r = renderTimer();
  await settle();
  // Today is held, as the app always holds it.
  await act(() => r.result.current.store.load(TODAY));
  return r;
}

/** A session that started `minutes` ago with the default 25 min plan. */
export const startedAgo = (minutes: number, patch: Partial<RunningSession> = {}) => makeSession({ startedAt: Date.now() - minutes * MINUTE_MS, ...patch });

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  vi.mocked(api.getDay).mockResolvedValue(answered(makeDay()));
  localStorage.clear();
});
