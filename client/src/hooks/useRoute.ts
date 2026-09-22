import { useCallback, useEffect, useState } from 'react';
import { isValidDateKey, todayKey } from '../lib/format';
import { useLatest } from './useLatest';

export interface Route {
  view: 'sheet' | 'history';
  /**
   * The date on screen, or null for today. Today is kept as null rather than as its key so a
   * sheet left open past midnight moves to the new day, the way a reload of the same URL does.
   */
  date: string | null;
}

function read(): Route {
  const params = new URLSearchParams(window.location.search);
  const date = params.get('date');
  return {
    view: params.get('view') === 'history' ? 'history' : 'sheet',
    date: date && isValidDateKey(date) && date !== todayKey() ? date : null,
  };
}

function write(route: Route): void {
  const params = new URLSearchParams();
  if (route.view === 'history') params.set('view', 'history');
  if (route.date != null) params.set('date', route.date);
  const qs = params.toString();
  history.pushState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
}

/** The sheet's date and view live in the URL so reloads and back/forward behave. */
export function useRoute(): [Route, (next: Partial<Route>) => void] {
  const [route, setRoute] = useState<Route>(read);
  // Read through a ref rather than inside the updater: React runs updaters twice under
  // StrictMode, and a pushState in there would push two history entries per navigation.
  const current = useLatest(route);
  useEffect(() => {
    const onPop = () => setRoute(read());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback(
    (next: Partial<Route>) => {
      const merged = { ...current.current, ...next };
      if (merged.date === todayKey()) merged.date = null;
      // Already there (the brand button on today's sheet): a push would add an entry Back
      // has to step through without anything changing.
      if (merged.view === current.current.view && merged.date === current.current.date) return;
      write(merged);
      setRoute(merged);
    },
    [current],
  );
  return [route, navigate];
}
