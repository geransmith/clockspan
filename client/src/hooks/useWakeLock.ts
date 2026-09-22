import { useEffect } from 'react';

/**
 * Holds a Screen Wake Lock while `active`. The lock is released by the OS whenever the
 * page is hidden, so it is re-requested on visibilitychange. Unsupported browsers no-op.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      if (cancelled || document.visibilityState !== 'visible') return;
      // One lock at a time: a visibilitychange that finds the last one still held (the page
      // never went hidden) must not stack a second request on top of it.
      if (sentinel && !sentinel.released) return;
      try {
        const lock = await navigator.wakeLock.request('screen');
        // `active` went false (pause, setting off) while the request was out: this lock would
        // otherwise be held until the page hides, with nothing left that can release it.
        if (cancelled) void lock.release();
        else sentinel = lock;
      } catch {
        // Denied (low battery, not allowed) — nothing to do.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void sentinel?.release();
    };
  }, [active]);
}
