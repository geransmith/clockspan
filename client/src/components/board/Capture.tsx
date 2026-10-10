import { useLayoutEffect, useRef, useState } from 'react';
import { LIMITS } from '../../../../shared/api.js';
import { useLatest } from '../../hooks/useLatest';
import { activeCategories, COLUMN_NAMES, type CategoryPick, type ColumnId } from '../../lib/board';
import { CategoryChip } from '../CategoryChip';

/**
 * A column's box, opened by the + in its head: a task that came up goes in with a keystroke and
 * the box is ready for the next one. Enter adds the text in the category beside the box, which
 * every column's box shares (`category`, kept by the board; a removed or unknown one reads as none).
 * An empty Enter or Escape closes the box with the focus back on the +, Escape dropping the text;
 * leaving it closes it only while it is empty. A store write that shows at once, not a form send:
 * the board's banner says if it failed.
 */
export function Capture({
  to,
  pick,
  inputRef,
  category: remembered,
  onCategory,
  onEdit,
  onAdd,
  onClose,
}: {
  to: Exclude<ColumnId, 'done'>;
  pick: CategoryPick;
  inputRef: (el: HTMLInputElement | null) => void;
  category: string | null;
  onCategory: (uid: string | null) => void;
  /** The text was changed. */
  onEdit?: () => void;
  /** False when the text is held (In Progress's nudge): it stays in the box. */
  onAdd: (title: string, categoryUid: string | null) => boolean;
  /** `back`: the focus goes back to the column's +. */
  onClose: (back: boolean) => void;
}) {
  const [text, setText] = useState('');
  const category = activeCategories(pick.categories).some((c) => c.uid === remembered) ? remembered : null;
  const today = to === 'progress';
  // A box that goes with the focus in it (its + shut at the cap or on a full list) hears no blur,
  // so the focus goes back to the +. A layout cleanup runs while the box is still in the page.
  const box = useRef<HTMLDivElement>(null);
  const close = useLatest(onClose);
  useLayoutEffect(
    () => () => {
      if (box.current!.contains(document.activeElement)) close.current(true);
    },
    [close],
  );
  return (
    <div
      ref={box}
      className="board-add-box"
      // Its handlers only hear the field's and the chip's keys and focus as they bubble, so the
      // wrapper is presentation to a screen reader. The chip's list stops its own Escape, so Escape
      // there closes only the list.
      role="presentation"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.nativeEvent.isComposing) onClose(true);
      }}
      // The window losing the focus (another app) closes nothing, and neither does the chip's list,
      // which renders inside the box.
      onBlur={(e) => {
        if (!text.trim() && !e.currentTarget.contains(e.relatedTarget) && document.hasFocus()) onClose(false);
      }}
    >
      <input
        ref={inputRef}
        className="input"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onEdit?.();
        }}
        onKeyDown={(e) => {
          // An input method's Enter picks a candidate: it adds nothing.
          if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
          e.preventDefault();
          const title = text.trim();
          if (!title) onClose(true);
          else if (onAdd(title, category)) setText('');
        }}
        placeholder={today ? 'New priority' : 'New card'}
        aria-label={today ? 'New priority for today' : `New card for ${COLUMN_NAMES[to]}`}
        maxLength={LIMITS.priorityText}
      />
      <CategoryChip value={category} onChange={onCategory} pick={pick} label="Category for new cards" />
    </div>
  );
}
