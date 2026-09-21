import { useCallback, useEffect, useState } from 'react';
import { isValidDateKey, todayKey } from '../lib/format';
import { useLatest } from './useLatest';

export interface Route {
  view: 'sheet' | 'history';
  date: string;
}

function read(): Route {
  const params = new URLSearchParams(window.location.search);
  const date = params.get('date');
  return {
    view: params.get('view') === 'history' ? 'history' : 'sheet',
    date: date && isValidDateKey(date) ? date : todayKey(),
  };
}

function write(route: Route, replace = false): void {
  const params = new URLSearchParams();
  if (route.view === 'history') params.set('view', 'history');
  if (route.date !== todayKey()) params.set('date', route.date);
  const qs = params.toString();
  const url = `${window.location.pathname}${qs ? `?${qs}` : ''}`;
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
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
