import { useEffect, useRef, useState } from 'react';
import { warnSaveFailed } from '../lib/alerts';

export type SaveState = 'idle' | 'saving' | 'saved' | 'failed';
/** Runs a provider call and says in the header whether it saved. */
export type Save = (run: () => Promise<void>) => Promise<void>;

/** How long "Saved" stays up before the header goes quiet. "Not saved" stays until the next save. */
const SAVED_MS = 2500;

/**
 * Tracks in-flight settings saves so the header can say "Saving…", then "Saved" once the server
 * has confirmed, or "Not saved" when the save failed and the provider dropped the change, so the
 * stored value shows again. In-flight saves are counted so a burst of chip clicks reads as one
 * save instead of flickering between states. `run` is any provider call that settles when the
 * server has answered (update or reset, or a board write from the Board tab). A save that fails
 * after the dialog has closed raises the quiet "Change not saved" banner instead, as the other
 * stores do, since no header is left to say so.
 */
export function useSaveStatus(): { saveState: SaveState; save: Save } {
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const pending = useRef(0);
  const failed = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const open = useRef(false);

  // Set in the body, not at creation: StrictMode runs this cleanup once on mount.
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
      window.clearTimeout(timer.current);
    };
  }, []);

  const save: Save = async (run) => {
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
      if (!open.current) {
        if (failed.current) warnSaveFailed();
      } else if (pending.current === 0) {
        if (failed.current) setSaveState('failed');
        else {
          setSaveState('saved');
          timer.current = window.setTimeout(() => setSaveState('idle'), SAVED_MS);
        }
      }
    }
  };

  return { saveState, save };
}
