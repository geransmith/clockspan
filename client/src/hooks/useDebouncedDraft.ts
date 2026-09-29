import { useCallback, useEffect, useRef, useState } from 'react';
import { useLatest } from './useLatest';

/**
 * A local copy of a stored value for a field the user types into. An edit is saved `ms` after
 * the last one, or at once when it is made with `now` (a tick, an added row) or on `flush()`
 * (leaving the field, a button that needs it saved first). Leaving the day inside the wait
 * (browser Back, a swipe) unmounts the card without a blur, so the unmount saves too; the
 * store outlives the card and the save still lands. While nothing is waiting to be saved the
 * draft follows `stored`, so a change from another device shows; a draft being typed is kept.
 * `stored` must keep its identity between renders when nothing changed (memoize a derived one).
 */
export function useDebouncedDraft<T>(
  stored: T,
  save: (value: T) => void,
  ms: number,
): { draft: T; edit: (value: T, now?: boolean) => void; flush: () => void } {
  const [draft, setDraft] = useState(stored);
  // The edit waiting to be saved, boxed so any value (an empty string) counts as one.
  const unsaved = useRef<{ value: T } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const latestSave = useLatest(save);

  // A ref can't be read during render, so this is the effect form of adopting the prop.
  useEffect(() => {
    if (!unsaved.current) setDraft(stored);
  }, [stored]);

  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    const pending = unsaved.current;
    unsaved.current = null;
    if (pending) latestSave.current(pending.value);
  }, [latestSave]);

  const edit = useCallback(
    (value: T, now = false) => {
      setDraft(value);
      unsaved.current = { value };
      window.clearTimeout(timer.current);
      if (now) flush();
      else timer.current = window.setTimeout(flush, ms);
    },
    [flush, ms],
  );

  useEffect(() => flush, [flush]);

  return { draft, edit, flush };
}
