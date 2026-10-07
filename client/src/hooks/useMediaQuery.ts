import { useCallback, useSyncExternalStore } from 'react';

/**
 * Whether the media query matches, kept current as it changes (a mouse plugged in, a window
 * resized). For behaviour that follows the device, like the board's capture box focusing itself
 * where there is a fine pointer; what only changes the look stays in the stylesheet's own queries.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => matchMedia(query).matches);
}
