import type { ReactNode } from 'react';
import { BoardProvider } from './useBoard';
import { BreakProvider } from './useBreak';
import { ClockProvider } from './useClock';
import { DayProvider } from './useDay';
import { SettingsProvider } from './useSettings';
import { TimerProvider } from './useTimer';

/**
 * The app's provider stack. App.tsx renders it under the gate, and the hook and component tests
 * render it too (re-exported by test/hooks.tsx), so the tests run on the app's order. The order
 * matters because a provider can only read the ones outside it: the day store reads the
 * settings, the board the settings and days (a board move writes today's list through the day
 * store), the timer the clock, settings and days, and the break the clock, settings, days and
 * timer.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ClockProvider>
      <SettingsProvider>
        <DayProvider>
          <BoardProvider>
            <TimerProvider>
              <BreakProvider>{children}</BreakProvider>
            </TimerProvider>
          </BoardProvider>
        </DayProvider>
      </SettingsProvider>
    </ClockProvider>
  );
}
