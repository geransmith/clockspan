import { useId, useRef, useState } from 'react';
import { LIMITS } from '../../../../shared/api.js';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { BOARD } from '../../lib/copy';
import type { OpenLane } from '../../types';

/**
 * The board's capture box: a task that came up goes on a card in a keystroke and the box is
 * ready for the next one. Enter puts it at the top of Later, Shift+Enter at the end of Next.
 * A store write that shows at once, not a form send: the board's banner says if it failed.
 */
export function Capture({ full, onAdd }: { full: boolean; onAdd: (title: string, lane: OpenLane) => void }) {
  // With a mouse and keyboard the box takes the focus as the board opens; on a phone that would
  // pull the keyboard up over the columns.
  const fine = useMediaQuery('(pointer: fine)');
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const add = (lane: OpenLane) => {
    const title = text.trim();
    if (!title) return;
    onAdd(title, lane);
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
