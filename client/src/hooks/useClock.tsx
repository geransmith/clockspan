import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

const Ctx = createContext<number | null>(null);

/**
 * The app's one 1-second clock: the sheet, the timer and the break read it, so they tick
 * together and the tree renders once a second rather than once per clock.
 */
export function ClockProvider({ children }: { children: ReactNode }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const id = setInterval(tick, 1000);
    // A hidden tab's timers are throttled, so the clock can be far behind when it comes back.
    // No `focus` listener, for the same reason as in useRefreshLoop.
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return <Ctx.Provider value={now}>{children}</Ctx.Provider>;
}

/** The time as of this second's tick. */
export function useClock(): number {
  const now = useContext(Ctx);
  if (now == null) throw new Error('useClock outside ClockProvider');
  return now;
}
