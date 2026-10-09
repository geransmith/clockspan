import { useId, useState, type RefObject } from 'react';
import { LIMITS } from '../../../../shared/api.js';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { activeCategories, type CategoryPick } from '../../lib/board';
import { BOARD } from '../../lib/copy';
import { readStored, USER_KEYS, writeStored } from '../../lib/storage';
import type { OpenLane } from '../../types';
import { CategoryChip } from '../CategoryChip';

/**
 * The board's capture box: a task that came up goes on a card in a keystroke and the box is
 * ready for the next one. Enter puts it at the top of Later, Shift+Enter at the end of Next, in
 * the category beside the box, which stays picked for the next card and is remembered on this
 * device (a removed or unknown one reads as none). A store write that shows at once, not a form
 * send: the board's banner says if it failed.
 */
export function Capture({
  full,
  pick,
  inputRef: input,
  onAdd,
}: {
  full: boolean;
  pick: CategoryPick;
  /** The box, which the board also focuses after a Delete leaves nothing else in the column. */
  inputRef: RefObject<HTMLInputElement | null>;
  onAdd: (title: string, lane: OpenLane, categoryUid: string | null) => void;
}) {
  // With a mouse and keyboard the box takes the focus as the board opens; on a phone that would
  // pull the keyboard up over the columns.
  const fine = useMediaQuery('(pointer: fine)');
  const [text, setText] = useState('');
  const [stored, setStored] = useState(() => readStored(USER_KEYS.captureCategory) || null);
  const hintId = useId();
  const category = activeCategories(pick.categories).some((c) => c.uid === stored) ? stored : null;
  const pickCategory = (uid: string | null) => {
    setStored(uid);
    writeStored(USER_KEYS.captureCategory, uid ?? '');
  };
  const add = (lane: OpenLane) => {
    const title = text.trim();
    if (!title) return;
    onAdd(title, lane, category);
    setText('');
    input.current?.focus();
  };
  return (
    <div className="board-capture">
      <div className="board-capture-row">
        <input
          ref={input}
          className="input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // An input method's Enter picks a candidate: it adds nothing.
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              add(e.shiftKey ? 'next' : 'later');
            }
            if (e.key === 'Escape') e.currentTarget.blur();
          }}
          placeholder="Add a card"
          aria-label="Add a card"
          aria-describedby={fine || full ? hintId : undefined}
          maxLength={LIMITS.priorityText}
          autoFocus={fine}
          disabled={full}
        />
        <CategoryChip value={category} onChange={pickCategory} pick={pick} label="Category for new cards" />
        <button className="btn" onClick={() => add('later')} disabled={full || !text.trim()}>
          Add to Later
        </button>
      </div>
      {(fine || full) && (
        <p className="muted small" id={hintId}>
          {full ? BOARD.full : 'Enter adds to Later, Shift+Enter to Next'}
        </p>
      )}
    </div>
  );
}
