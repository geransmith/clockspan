// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { SHORTCUTS, shortcutFor, type ShortcutId } from './shortcuts';

/** What the guard makes of a keydown at `target`, as the window's listener sees it once the event has bubbled up. */
function keyAt(target: EventTarget, key: string, init: KeyboardEventInit = {}, handled = false): ShortcutId | null {
  let found: ShortcutId | null = null;
  const listen = (e: KeyboardEvent) => {
    found = shortcutFor(e);
  };
  const take = (e: Event) => e.preventDefault();
  if (handled) target.addEventListener('keydown', take);
  window.addEventListener('keydown', listen);
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  window.removeEventListener('keydown', listen);
  target.removeEventListener('keydown', take);
  return found;
}

/** An element put in the page, from its markup. */
function add(html: string): HTMLElement {
  document.body.insertAdjacentHTML('beforeend', html);
  return document.body.lastElementChild as HTMLElement;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('shortcutFor', () => {
  it('maps each key to one shortcut, a letter whatever its case', () => {
    expect(keyAt(document.body, 'n')).toBe('new');
    expect(keyAt(document.body, 'N', { shiftKey: true })).toBe('new');
    expect(keyAt(document.body, '?', { shiftKey: true })).toBe('help');
    expect(keyAt(document.body, '+')).toBe('more');
    expect(keyAt(document.body, 'r')).toBe('rest');
  });

  it('gives every shortcut its own key', () => {
    const keys = Object.values(SHORTCUTS).map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('ignores Ctrl, Cmd and Alt/Option, a held key, a composing key and one already handled', () => {
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { repeat: true }, { isComposing: true }]) {
      expect(keyAt(document.body, 'h', init), JSON.stringify(init)).toBeNull();
    }
    expect(keyAt(document.body, 'h', {}, true)).toBeNull();
  });

  it('ignores Escape, Enter, Space, the arrows, the minus key and any letter not in the list', () => {
    for (const key of ['Escape', 'Enter', ' ', 'ArrowUp', '-', 'x']) expect(keyAt(document.body, key), key).toBeNull();
  });

  it('ignores keys in a text box, a text area, a select, a time segment and the category list, and takes them on a button or a checkbox', () => {
    const typing = [
      '<input type="text" />',
      '<input />',
      '<textarea></textarea>',
      '<select><option>One</option></select>',
      '<div><span contenteditable="true">08</span></div>',
      '<ul role="listbox"><li role="option">Admin</li></ul>',
    ];
    for (const html of typing) {
      const el = add(html);
      expect(keyAt(el.querySelector('span, li') ?? el, 'h'), html).toBeNull();
    }
    for (const html of ['<button>Go</button>', '<input type="checkbox" />', '<input type="radio" />', '<span contenteditable="false">x</span>']) {
      expect(keyAt(add(html), 'h'), html).toBe('history');
    }
  });

  it('ignores keys while a dialog is open or an item is being dragged', () => {
    const dialog = add('<dialog><button>Close</button></dialog>') as HTMLDialogElement;
    dialog.showModal();
    expect(keyAt(dialog.querySelector('button')!, '?')).toBeNull();
    dialog.close();
    expect(keyAt(document.body, '?')).toBe('help');
    // dnd-kit's grip while it is dragged; a pressed toggle with no role description is no drag.
    const grip = add('<button aria-roledescription="sortable" aria-pressed="false">Grip</button>');
    add('<button aria-pressed="true">Board</button>');
    expect(keyAt(grip, 'h')).toBe('history');
    grip.setAttribute('aria-pressed', 'true');
    expect(keyAt(grip, 'h')).toBeNull();
  });
});
