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
 *
 * `save` says whether the draft can be let go. An edit stays unsaved, and the draft does not
 * follow `stored`, until its save answers true; one that answers false stays in the box and
 * goes again on the next edit, flush or unmount. A flush while a save is out sends nothing
 * more. `flush()` resolves to whether the draft is saved.
 */
export function useDebouncedDraft<T>(
  stored: T,
  save: (value: T) => boolean | Promise<boolean>,
  ms: number,
): { draft: T; edit: (value: T, now?: boolean) => void; flush: () => Promise<boolean> } {
  const [draft, setDraft] = useState(stored);
  // The edit waiting to be saved, boxed so any value (an empty string) counts as one, with its
  // save while that is out.
  const unsaved = useRef<{ value: T; sent?: Promise<boolean> } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const latestSave = useLatest(save);

  // A ref can't be read during render, so this is the effect form of adopting the prop.
  useEffect(() => {
    if (!unsaved.current) setDraft(stored);
  }, [stored]);

  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    const box = unsaved.current;
    if (!box) return Promise.resolve(true);
    box.sent ??= Promise.resolve(latestSave.current(box.value)).then((ok) => {
      // An edit made since has a box of its own, which this answer says nothing about.
      if (unsaved.current === box) {
        if (ok) unsaved.current = null;
        else box.sent = undefined;
      }
      return ok;
    });
    return box.sent;
  }, [latestSave]);

  const edit = useCallback(
    (value: T, now = false) => {
      setDraft(value);
      unsaved.current = { value };
      window.clearTimeout(timer.current);
      if (now) void flush();
      else timer.current = window.setTimeout(() => void flush(), ms);
    },
    [flush, ms],
  );

  useEffect(() => () => void flush(), [flush]);

  return { draft, edit, flush };
}
