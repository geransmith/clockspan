import { useEffect, useRef, useState, type Ref } from 'react';
import { useBoardState, useBoardStore, useCategoryPick } from '../hooks/useBoard';
import { useLatest } from '../hooks/useLatest';
import { laterTop, saved } from '../lib/board';
import { LATER_ADDED } from '../lib/copy';
import { newUid } from '../lib/priorities';
import { readStored, USER_KEYS, writeStored } from '../lib/storage';
import { Capture } from './Capture';
import { ErrorLine } from './ErrorLine';
import { X } from './Icons';

const ERROR_ID = 'later-strip-error';

/**
 * The Later strip, opened by the header's Add to Later or L on the sheet and History: a box under
 * the header whose Enter puts a card at the top of Later, through the board's queue, and keeps the
 * box open for the next. App mounts it only while it is open, so each opening starts empty; a close
 * (Escape, ×, an empty Enter, the header's button, or leaving it empty) clears it. On the Board it
 * is `hidden`, not unmounted, so text left in it is there on the way back. Its line says when the
 * last card saved, or why it didn't, in place of the banner: only for a save of this opening that
 * fails while it shows. The banner says the rest (one that fails after a close, or while hidden).
 */
export function LaterStrip({ hidden, inputRef, onClose }: { hidden: boolean; inputRef: Ref<HTMLInputElement>; onClose: () => void }) {
  const { board } = useBoardState();
  const store = useBoardStore();
  const pick = useCategoryPick();
  // Shared with the board's boxes, and read again on the way back, where Later's box may have changed it.
  const [category, setCategory] = useState(() => readStored(USER_KEYS.captureCategory) || null);
  const [wasHidden, setWasHidden] = useState(hidden);
  if (hidden !== wasHidden) {
    setWasHidden(hidden);
    if (!hidden) setCategory(readStored(USER_KEYS.captureCategory) || null);
  }
  const [line, setLine] = useState<{ text: string; error: boolean } | null>(null);
  const live = useRef(false);
  // Set in the body, not at creation: StrictMode runs this cleanup once on mount.
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  // Read as the answer lands: a save sent while shown can fail after a trip to the Board.
  const shown = useLatest(!hidden);
  // Safe to run twice: the header's press can close it through the box's blur and its own click.
  // The header isn't sticky, so a bare focus would scroll a scrolled page to the top.
  const close = (back: boolean) => {
    onClose();
    if (back) document.getElementById('header-later')?.focus({ preventScroll: true });
  };
  if (!board || !pick) return null;

  const say = (text: string) => {
    if (!live.current || !shown.current) return false;
    setLine({ text, error: true });
    return true;
  };
  const add = (title: string, categoryUid: string | null) => {
    setLine(null);
    const write = store.addItem({ uid: newUid(), title, categoryUid, lane: 'later', before: laterTop(board.cards) });
    return saved(write, say).then((ok) => {
      if (ok) setLine({ text: LATER_ADDED(title), error: false });
      return ok;
    });
  };

  return (
    <div id="later-strip" className="later-strip" role="group" aria-label="Add to Later" hidden={hidden}>
      <div className="later-strip-inner">
        <Capture
          to="later"
          pick={pick}
          inputRef={inputRef}
          category={category}
          onCategory={(uid) => {
            setCategory(uid);
            writeStored(USER_KEYS.captureCategory, uid ?? '');
          }}
          onAdd={add}
          onClose={close}
          placeholder="Park a thought in Later"
          describedBy={line?.error ? ERROR_ID : undefined}
        >
          <button className="btn btn-ghost btn-icon" aria-label="Close" title="Close" onMouseDown={(e) => e.preventDefault()} onClick={() => close(true)}>
            <X />
          </button>
        </Capture>
        {/* Always there, so the first "Added" is heard. */}
        <p className="muted small" role="status">
          {line && !line.error ? line.text : ''}
        </p>
        <ErrorLine id={ERROR_ID} error={line?.error ? line.text : null} />
      </div>
    </div>
  );
}
