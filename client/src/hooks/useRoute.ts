import { useCallback, useEffect, useState } from 'react';
import { isValidDateKey, todayKey } from '../lib/format';

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
  useEffect(() => {
    const onPop = () => setRoute(read());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((next: Partial<Route>) => {
    setRoute((cur) => {
      const merged = { ...cur, ...next };
      write(merged);
      return merged;
    });
  }, []);
  return [route, navigate];
}
