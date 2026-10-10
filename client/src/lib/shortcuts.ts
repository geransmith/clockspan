/** A single-key shortcut: each acts as its button does, and only while that button would. */
export type ShortcutId = 'new' | 'sheet' | 'board' | 'history' | 'help' | 'pause' | 'finish' | 'more' | 'rest';
export type ShortcutGroup = 'add' | 'pages' | 'timer';

/**
 * Every key, in the order the list shows them. `key` is what `KeyboardEvent.key` gives,
 * uppercased, so a letter is the same with Shift or Caps Lock; `aria` is the key's name in
 * `aria-keyshortcuts` where that differs (ARIA joins keys with +, so the key itself is Plus).
 */
export const SHORTCUTS: Record<ShortcutId, { key: string; aria?: string; group: ShortcutGroup }> = {
  new: { key: 'N', group: 'add' },
  sheet: { key: 'S', group: 'pages' },
  board: { key: 'B', group: 'pages' },
  history: { key: 'H', group: 'pages' },
  help: { key: '?', group: 'pages' },
  pause: { key: 'P', group: 'timer' },
  finish: { key: 'F', group: 'timer' },
  more: { key: '+', aria: 'Plus', group: 'timer' },
  rest: { key: 'R', group: 'timer' },
};

const BY_KEY = new Map(Object.entries(SHORTCUTS).map(([id, s]) => [s.key, id as ShortcutId]));

// Where a key is typed or picks an option: a field (a time segment is contenteditable), a select
// and the category list. A checkbox or a radio takes no letters.
const TYPING = 'input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable]:not([contenteditable=false]), [role=listbox], [role=option]';

/**
 * The shortcut a keydown asks for, or null when the key belongs to something else: a key already
 * handled, held down or composing; one with Ctrl, Cmd or Alt/Option (the browser's and the
 * system's, and Option's letters on a Mac); one typed into a field; and any key while a dialog is
 * open or an item is dragged (dnd-kit presses what it drags by, `aria-pressed`, for the drag).
 */
export function shortcutFor(e: KeyboardEvent): ShortcutId | null {
  if (e.defaultPrevented || e.repeat || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return null;
  // Before the key: Chrome's autofill sends a field a keydown with no key.
  if (e.target instanceof Element && e.target.closest(TYPING)) return null;
  const id = BY_KEY.get(e.key.toUpperCase());
  if (!id || document.querySelector('dialog[open], [aria-roledescription][aria-pressed="true"]')) return null;
  return id;
}
