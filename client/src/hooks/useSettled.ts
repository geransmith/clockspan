import { useEffect, useState } from 'react';

/** Returns `value` only after it has stopped changing for `ms`. A new `ms` restarts the count from then. */
export function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return settled;
}
