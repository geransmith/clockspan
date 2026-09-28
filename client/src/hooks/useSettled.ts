import { useEffect, useState } from 'react';

/**
 * Returns `value` only after it has stopped changing for `ms`. While `hold` is true the
 * last settled value stays put whatever `value` does; the timer starts once it is released.
 */
export function useSettled<T>(value: T, ms: number, hold = false): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (hold) return;
    const id = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms, hold]);
  return settled;
}
