import { useCallback, useEffect, useRef, useState } from 'react';

export type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

/** How long "Saved" stays up before the header goes quiet. "Not saved" stays until the next save. */
const SAVED_MS = 2500;

/**
 * Tracks in-flight settings saves so the header can say "Saving…", then "Saved" once the server
 * has confirmed, or "Not saved" when the save failed and the provider dropped the change, so the
 * stored value shows again. In-flight saves are counted so a burst of chip clicks reads as one
 * save instead of flickering between states. `run` is any provider call that settles when the
 * server has answered (update or reset).
 */
export function useSaveStatus(): { saveState: SaveState; save: (run: () => Promise<void>) => Promise<void> } {
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const pending = useRef(0);
  const failed = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const save = useCallback(async (run: () => Promise<void>) => {
    if (pending.current === 0) failed.current = false;
    pending.current++;
    window.clearTimeout(timer.current);
    setSaveState('saving');
    try {
      await run();
    } catch {
      // The provider dropped the failed change, so the stored value shows again; all that is left is to say so.
      failed.current = true;
    } finally {
      pending.current--;
      if (pending.current === 0) {
        if (failed.current) setSaveState('failed');
        else {
          setSaveState('saved');
          timer.current = window.setTimeout(() => setSaveState('idle'), SAVED_MS);
        }
      }
    }
  }, []);

  return { saveState, save };
}
