import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
 *
 * `save` also gets the base, which every edit since was made on: the `stored` value the draft
 * last took up, or the value it last saved, whichever came later. A store that merges a save
 * with changes made elsewhere (the priorities list) needs it to tell this device's changes from
 * those.
 *
 * `kept` starts the draft as an edit not saved yet, made on `stored`: one an earlier draft of the
 * same value failed to save (a board card's note, whose box goes with its dialog). It waits for
 * the next edit, flush or unmount like any other, and one that arrives while nothing waits (that
 * earlier draft's save failing after this one mounted) is taken up the same way.
 */
export function useDebouncedDraft<T>(
  stored: T,
  save: (value: T, base: T) => boolean | Promise<boolean>,
  ms: number,
  kept?: T,
): { draft: T; edit: (value: T, now?: boolean) => void; flush: () => Promise<boolean> } {
  const [draft, setDraft] = useState(kept === undefined ? stored : kept);
  const base = useRef(stored);
  // The `stored` value last taken up.
  const adopted = useRef(stored);
  // The edit waiting to be saved, boxed so any value (an empty string) counts as one, with its
  // save while that is out.
  const unsaved = useRef<{ value: T; sent?: Promise<boolean> } | null>(kept === undefined ? null : { value: kept });
  const timer = useRef<number | undefined>(undefined);
  const latestSave = useLatest(save);

  // A ref can't be read during render, so this is the effect form of adopting the props.
  useEffect(() => {
    if (unsaved.current) return;
    adopted.current = stored;
    if (kept !== undefined) {
      base.current = stored;
      unsaved.current = { value: kept };
    }
    setDraft(unsaved.current ? unsaved.current.value : stored);
  }, [stored, kept]);

  // A value taken up becomes the base once the draft holding it has rendered, not before: until
  // then a handler still builds on the draft before it. An edit made in that gap sets the draft
  // too, so the value taken up never renders and never becomes the base.
  useLayoutEffect(() => {
    if (draft === adopted.current) base.current = draft;
  }, [draft]);

  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    const box = unsaved.current;
    if (!box) return Promise.resolve(true);
    box.sent ??= Promise.resolve(latestSave.current(box.value, base.current)).then((ok) => {
      // Any edit after the save was made on the value saved, so that is the base from now on,
      // before the store's copy of it comes back as `stored`.
      if (ok) base.current = box.value;
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
