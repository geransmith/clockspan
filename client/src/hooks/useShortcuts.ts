import { useEffect, useId, useLayoutEffect, type RefObject } from 'react';
import { unlockAudio } from '../lib/alerts';
import { SHORTCUTS, shortcutFor, type ShortcutId } from '../lib/shortcuts';
import { useLatest } from './useLatest';
import { useSettings } from './useSettings';

// Every binding, in the order they mounted. A module's state, as alerts.ts keeps its banners, so a
// card that binds a key needs no shortcut provider of its own.
const bindings = new Map<string, { id: ShortcutId; run: RefObject<(() => void) | null> }>();

/** The newest mounted binding of the key that has something to run. */
function newest(id: ShortcutId): (() => void) | null {
  let found: (() => void) | null = null;
  for (const b of bindings.values()) if (b.id === id && b.run.current) found = b.run.current;
  return found;
}

/**
 * Binds a key beside the button it stands for, while `run` is given: pass null whenever the
 * button wouldn't act (hidden, disabled), so the key doesn't either. Where two mounted components
 * bind one key (the timer bar's and the timer card's buttons), the newest runs, and the older
 * takes over when it unmounts. A binding keeps its place while `run` comes and goes. Call it
 * before any early return. Answers the key for the button's `aria-keyshortcuts` while it is
 * bound and shortcuts are on.
 */
export function useShortcut(id: ShortcutId, run: (() => void) | null): string | undefined {
  const key = useId();
  const latest = useLatest(run);
  const { settings, loaded } = useSettings();
  useLayoutEffect(() => {
    bindings.set(key, { id, run: latest });
    return () => void bindings.delete(key);
  }, [key, id, latest]);
  const { key: pressed, aria = pressed } = SHORTCUTS[id];
  return run && loaded && settings.shortcuts ? aria : undefined;
}

/**
 * The one keydown listener, on the window, so a field's and dnd-kit's own handlers run first. Not
 * before the settings have loaded, so a user who turned the keys off never has one act.
 */
export function useShortcutListener(): void {
  const { settings, loaded } = useSettings();
  const on = loaded && settings.shortcuts;
  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent) => {
      const id = shortcutFor(e);
      const run = id ? newest(id) : null;
      if (!id || !run) return;
      // The letter isn't typed into the field the key may have just focused.
      e.preventDefault();
      // A timer key's chime plays later (a moved end, a break's end), and iOS plays one only once a gesture unlocked audio.
      if (SHORTCUTS[id].group === 'timer') unlockAudio();
      run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [on]);
}
