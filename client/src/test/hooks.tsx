import { act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { DayProvider } from '../hooks/useDay';
import { SettingsProvider } from '../hooks/useSettings';

export * from './fixtures';
export { AppProviders as AllProviders } from '../hooks/AppProviders';

/**
 * The app's provider stack (AllProviders, re-exported from hooks/AppProviders.tsx),
 * SettingsAndDays and the act() helpers for the hook and component tests, which run under
 * happy-dom with fake timers. The plain factories and TEST_SETTINGS live in `fixtures.ts`, with
 * no React; this module re-exports them, so a happy-dom test imports one module, while a lib
 * test (`node`) imports `fixtures.ts`. Each test file mocks the `api` module (and `lib/alerts`
 * where banners matter) itself: `vi.mock` only applies in the file that calls it.
 */

export const MIN = 60_000;

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
