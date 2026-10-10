import { flushSync } from 'react-dom';
import { useDebouncedDraft } from '../hooks/useDebouncedDraft';
import { LIMITS } from '../../../shared/api.js';
import { hasNote, taskNote } from '../../../shared/text.js';
import { Note } from './Icons';

/** The note button's id, from its box's. */
const buttonId = (boxId: string) => `${boxId}-button`;

/**
 * A task's note button on a Top priorities row, kept out of `components/board/` so the sheet can
 * show it without the board's chunk (the box is also a board card's dialog's). It is the row's one
 * sign of a note: drawn filled with one, and quiet with none (with a mouse it shows on its row's
 * hover or focus, as an empty category chip does). It opens and closes the note's box
 * (`NoteField`, whose id is `boxId`), and the focus goes into the box it opens. `of` names the
 * task: "priority 3".
 */
export function NoteToggle({ boxId, of, note, open, onToggle }: { boxId: string; of: string; note: string; open: boolean; onToggle: (open: boolean) => void }) {
  const has = hasNote(note);
  return (
    <button
      id={buttonId(boxId)}
      className={`btn btn-ghost btn-icon note-toggle${has ? '' : ' note-toggle--empty'}`}
      aria-expanded={open}
      aria-controls={boxId}
      aria-label={has ? `Note for ${of}` : `Add a note to ${of}`}
      title={has ? 'Note' : 'Add a note'}
      onClick={() => {
        // Rendered at once, so the box is shown to take the focus inside the same press.
        flushSync(() => onToggle(!open));
        if (!open) document.getElementById(boxId)?.focus();
      }}
    >
      <Note filled={has} />
    </button>
  );
}

/**
 * A task's note, shown while its button has it open: a box that grows to eight lines and then
 * scrolls, where Enter adds a line. It saves `ms` after the last key and when the focus leaves it;
 * Escape closes it, the text kept, with the focus back on its button. It stays mounted while
 * closed, so a note whose save failed stays in its box, open or not, and goes again on the next
 * edit, on leaving the box, or when the box goes (another day, a reload). Without `onSave` (where
 * the title can't be edited either) the note is plain text. In a board card's dialog it is always
 * open, with no button and no `onClose`: its Escape is the dialog's, and `kept` is the text a
 * save failed for as the dialog last closed, which goes again as it would have in the box.
 */
export function NoteField({
  id,
  of,
  note,
  kept,
  open,
  onClose,
  onSave,
  ms,
}: {
  id: string;
  of: string;
  note: string;
  kept?: string;
  open: boolean;
  onClose?: () => void;
  /** Resolves to whether the note saved; `base` is the stored note it was typed over. */
  onSave?: (note: string, base: string) => Promise<boolean>;
  ms: number;
}) {
  const { draft, edit, flush } = useDebouncedDraft(note, (value, base) => onSave?.(value, base) ?? true, ms, kept);
  if (!onSave) {
    return (
      <p id={id} className="note-field note-text" hidden={!open}>
        {note}
      </p>
    );
  }
  return (
    <span className="grow-field note-field" data-value={draft || 'Add a note'} hidden={!open}>
      <textarea
        id={id}
        className="input note-input"
        rows={1}
        value={draft}
        placeholder="Add a note"
        aria-label={`Note for ${of}`}
        maxLength={LIMITS.itemNote}
        // As the server will store it, so the box and the stored note agree.
        onChange={(e) => edit(taskNote(e.target.value))}
        onBlur={() => void flush()}
        onKeyDown={(e) => {
          // An input method's Escape drops a candidate.
          if (e.key !== 'Escape' || e.nativeEvent.isComposing) return;
          // The blur the focus's move brings saves it.
          document.getElementById(buttonId(id))?.focus();
          onClose?.();
        }}
      />
    </span>
  );
}
