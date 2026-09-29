import { createContext, useContext, type ReactNode } from 'react';
import { useNow } from './useNow';

const Ctx = createContext<number | null>(null);

/**
 * The app's one 1-second clock (`useNow`): the sheet, the timer and the break read it, so they
 * tick together and the tree renders once a second rather than once per clock.
 */
export function ClockProvider({ children }: { children: ReactNode }) {
  return <Ctx.Provider value={useNow(1000)}>{children}</Ctx.Provider>;
}

/** The time as of this second's tick. */
export function useClock(): number {
  const now = useContext(Ctx);
  if (now == null) throw new Error('useClock outside ClockProvider');
  return now;
}
