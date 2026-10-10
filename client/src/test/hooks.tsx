import { act, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, vi } from 'vitest';
import * as api from '../api';
import { BoardProvider } from '../hooks/useBoard';
import { DayProvider } from '../hooks/useDay';
import { SettingsProvider } from '../hooks/useSettings';
import { useShortcutListener } from '../hooks/useShortcuts';
import type { Day } from '../types';
import { answered, apiError, makeBoard } from './fixtures';

export * from './fixtures';
export { AppProviders } from '../hooks/AppProviders';

/**
 * The app's provider stack (AppProviders, re-exported from hooks/AppProviders.tsx),
 * SettingsAndDays, serveRange and the act() helpers for the hook and component tests, which run
 * under happy-dom with fake timers. The plain factories and TEST_SETTINGS live in `fixtures.ts`,
 * with no React; this module re-exports them, so a happy-dom test imports one module, while a
 * lib test (`node`) imports `fixtures.ts`. Each test file mocks the `api` module (and
 * `lib/alerts` where banners matter) itself: `vi.mock` only applies in the file that calls it.
 * Before each test of a file that mocks `api`, an automocked `getBoard` answers an empty board.
 */

// Every provider stack reads the board (BoardProvider), and an automocked call answers undefined.
// A file's own beforeEach runs after this one, so a file or test that needs another board mocks it.
beforeEach(() => {
  if (vi.isMockFunction(api.getBoard)) vi.mocked(api.getBoard).mockResolvedValue(answered(makeBoard()));
});

/** Moves the fake clock (0 = just the pending promises) and lets React render what changed. */
export async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Starts one call inside act() and hands back its promise, for a test that awaits it later. */
export function begin<T>(fn: () => Promise<T>): Promise<T> {
  let p!: Promise<T>;
  act(() => {
    p = fn();
  });
  return p;
}

/** The server answers a range with the days it holds in it; the calling test mocks '../api'. */
export function serveRange(days: Day[]): void {
  vi.mocked(api.getRange).mockImplementation((from, to) => Promise.resolve(answered({ days: days.filter((d) => d.date >= from && d.date <= to) })));
}

/**
 * A write the server refuses as gone (404) or changed (409), the way `request()` refuses it:
 * CHANGED_ELSEWHERE first, then the ApiError. The calling test mocks '../api'.
 */
export function refused(status: 404 | 409, revision = 0): Promise<never> {
  window.dispatchEvent(new CustomEvent(api.CHANGED_ELSEWHERE, { detail: revision }));
  return Promise.reject(apiError(status, revision));
}

/** Fires `visibilitychange` with the page shown or hidden. */
export function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

/** The settings, the day store and the board: the stores a card or a settings tab reads, without the clock and the timer. */
export function SettingsAndDays({ children }: { children: ReactNode }) {
  return (
    <SettingsProvider>
      <DayProvider>
        <BoardProvider>{children}</BoardProvider>
      </DayProvider>
    </SettingsProvider>
  );
}

/** The keydown listener App mounts (`Shortcuts`), for a test that presses a card's key; inside the settings' provider. */
export function ShortcutKeys() {
  useShortcutListener();
  return null;
}

/** A key pressed where the focus is, as the browser sends it: false once something took it (`preventDefault`). */
export function pressKey(key: string, init: KeyboardEventInit = {}): boolean {
  return fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });
}
