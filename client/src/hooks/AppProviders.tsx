import type { ReactNode } from 'react';
import { BreakProvider } from './useBreak';
import { ClockProvider } from './useClock';
import { DayProvider } from './useDay';
import { SettingsProvider } from './useSettings';
import { TimerProvider } from './useTimer';

/**
 * The app's provider stack. App.tsx renders it under the gate, and the hook and component tests
 * render it as AllProviders (test/hooks.tsx), so the tests run on the app's order. The order
 * matters because a provider can only read the ones outside it: the day store reads the
 * settings, the timer the clock, settings and days, and the break all four.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ClockProvider>
      <SettingsProvider>
        <DayProvider>
          <TimerProvider>
            <BreakProvider>{children}</BreakProvider>
          </TimerProvider>
        </DayProvider>
      </SettingsProvider>
    </ClockProvider>
  );
}
